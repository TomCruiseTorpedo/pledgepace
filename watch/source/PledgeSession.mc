import Toybox.Activity;
import Toybox.ActivityMonitor;
import Toybox.ActivityRecording;
import Toybox.Application;
import Toybox.Attention;
import Toybox.Communications;
import Toybox.FitContributor;
import Toybox.Lang;
import Toybox.Position;
import Toybox.Sensor;
import Toybox.System;
import Toybox.Timer;
import Toybox.UserProfile;
import Toybox.WatchUi;

//! Records the run, reports distance to the PledgePace server and holds the
//! live total it sends back. Money is only ever calculated on the server.
class PledgeSession {
    // Read once at start: sideloaded apps never receive settings from the phone.
    private var _serverUrl as String = "";
    private var _runnerId as String = "runner-1";
    private var _relayKey as String = "";
    private var _pollSeconds as Number = 5;

    private var _recording as ActivityRecording.Session?;
    private var _raisedField as FitContributor.Field?;
    private var _totalField as FitContributor.Field?;

    private var _timer as Timer.Timer;
    private var _ticks as Number = 0;
    private var _inFlight as Boolean = false;
    private var _finishPending as Boolean = false;
    private var _lastMilestone as Number = 0;
    // Frozen at finish, because Activity info resets once the activity is saved.
    // Without this the finishing poll could report a reset distance to the server.
    private var _finalDist as Float? = null;
    private var _finalTimer as Number? = null;

    var linkStatus as String = "Connecting";
    var gpsReady as Boolean = false;
    var raised as Float = 0.0;
    var ratePerKm as Float = 0.0;
    var pledgers as Number = 0;
    var milestone as Float = 25.0;
    var finished as Boolean = false;
    var settled as Boolean = false;

    // Goal mode: the server says so per runner. "raised" then means money still at stake.
    var mode as String = "perKm";
    // Goal unit: "km" (GPS), "steps" (accelerometer), "floors" (barometer) or
    // "minutes" (time at or above heart-rate zone 2).
    var unit as String = "km";
    // "miss" = backers pay for the share missed (commitment); "progress" = for the share completed (charity).
    var payOn as String = "miss";
    var target as Float = 0.0;
    var progress as Float = 0.0;
    var heartRate as Number? = null;
    var stakeTotal as Float = 0.0;
    var goalMet as Boolean = false;
    private var _goalBuzzed as Boolean = false;
    private var _zoneSec as Number = 0; // seconds at or above zone 2 since the app started
    private var _zoneHr as Number = 100;

    function initialize() {
        readSettings();
        _zoneHr = zone2Floor();
        Sensor.setEnabledSensors([Sensor.SENSOR_HEARTRATE]);
        Position.enableLocationEvents(Position.LOCATION_CONTINUOUS, method(:onPosition));
        _timer = new Timer.Timer();
        _timer.start(method(:onTick), 1000, true);
    }

    // ---- recording ------------------------------------------------------

    function isRecording() as Boolean {
        var r = _recording;
        return r != null && r.isRecording();
    }

    function hasActivity() as Boolean {
        return _recording != null;
    }

    //! Distance in metres. After finish, the value frozen at finish.
    function distance() as Float? {
        if (_finalDist != null) {
            return _finalDist;
        }
        var info = Activity.getActivityInfo();
        return info != null ? info.elapsedDistance : null;
    }

    //! Timer in milliseconds. After finish, the value frozen at finish.
    function timerMs() as Number? {
        if (_finalTimer != null) {
            return _finalTimer;
        }
        var info = Activity.getActivityInfo();
        return info != null ? info.timerTime : null;
    }

    function startOrResume() as Void {
        if (finished) {
            return; // this run is over on the server; start a new app session for the next one
        }
        var r = _recording;
        if (r == null) {
            r = ActivityRecording.createSession({
                :name => "PledgePace",
                :sport => Activity.SPORT_RUNNING,
                :subSport => Activity.SUB_SPORT_GENERIC
            });
            // Field 0: dollars raised so far, charted next to pace. Field 1: the final total.
            // Ids match resources/fit/fit_contributions.xml.
            _raisedField = r.createField("pledge_raised", 0, FitContributor.DATA_TYPE_FLOAT,
                { :mesgType => FitContributor.MESG_TYPE_RECORD, :units => "$" });
            _totalField = r.createField("pledge_total", 1, FitContributor.DATA_TYPE_FLOAT,
                { :mesgType => FitContributor.MESG_TYPE_SESSION, :units => "$" });
            _recording = r;
        }
        r.start();
    }

    function pause() as Void {
        var r = _recording;
        if (r != null && r.isRecording()) {
            r.stop();
        }
    }

    //! Saves the activity and tells the server the run is over (retried until it lands).
    function finish() as Void {
        var r = _recording;
        if (r == null) {
            return;
        }
        if (r.isRecording()) {
            r.stop();
        }
        var info = Activity.getActivityInfo();
        if (info != null) {
            _finalDist = info.elapsedDistance;
            _finalTimer = info.timerTime;
        }
        setField(_totalField, raised);
        r.save();
        clearRecording();
        _finishPending = true;
    }

    function discard() as Void {
        var r = _recording;
        if (r == null) {
            return;
        }
        if (r.isRecording()) {
            r.stop();
        }
        r.discard();
        clearRecording();
    }

    function shutdown() as Void {
        _timer.stop();
        Position.enableLocationEvents(Position.LOCATION_DISABLE, method(:onPosition));
        finish();
    }

    private function clearRecording() as Void {
        _recording = null;
        _raisedField = null;
        _totalField = null;
    }

    private function setField(field as FitContributor.Field?, value as Float) as Void {
        if (field != null) {
            field.setData(value);
        }
    }

    // ---- server loop ----------------------------------------------------

    function onTick() as Void {
        _ticks += 1;
        var hr = readHeartRate();
        heartRate = hr;
        if (hr != null && hr >= _zoneHr) {
            _zoneSec += 1;
        }
        if (!_inFlight && (_finishPending || _ticks % _pollSeconds == 0)) {
            sendTelemetry();
        }
        WatchUi.requestUpdate();
    }

    function onPosition(info as Position.Info) as Void {
        var q = info.accuracy;
        gpsReady = q != null && q >= Position.QUALITY_USABLE;
    }

    private function sendTelemetry() as Void {
        if (_serverUrl.length() == 0) {
            linkStatus = "Set server URL";
            return;
        }
        var body = { "recording" => isRecording() } as Dictionary<Object, Object>;
        if (_finishPending) {
            body["finished"] = true;
        }
        var dist = distance();
        if (dist != null) {
            body["dist"] = dist;
        }
        var ms = timerMs();
        if (ms != null) {
            body["timer"] = ms;
        }
        // Sensor counters for goals; the server counts each from when the goal was set.
        body["zoneSec"] = _zoneSec;
        if (heartRate != null) {
            body["hr"] = heartRate;
        }
        var am = ActivityMonitor.getInfo();
        if (am.steps != null) {
            body["steps"] = am.steps;
        }
        if (am has :floorsClimbed && am.floorsClimbed != null) {
            body["floors"] = am.floorsClimbed;
        }
        _inFlight = true;
        Communications.makeWebRequest(
            _serverUrl + "/api/runs/" + _runnerId + "/telemetry",
            body,
            {
                :method => Communications.HTTP_REQUEST_METHOD_POST,
                :headers => {
                    "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON,
                    "X-Relay-Key" => _relayKey
                },
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            },
            method(:onTelemetryResponse)
        );
    }

    function onTelemetryResponse(code as Number, data as Dictionary or String or Null) as Void {
        _inFlight = false;
        if (code != 200 || !(data instanceof Dictionary)) {
            linkStatus = describe(code);
            WatchUi.requestUpdate();
            return;
        }
        linkStatus = "Linked";
        raised = toFloat(data["raised"], raised);
        ratePerKm = toFloat(data["ratePerKm"], ratePerKm);
        milestone = toFloat(data["milestone"], milestone);
        var n = data["pledgers"];
        if (n instanceof Number) {
            pledgers = n;
        }
        finished = data["finished"] == true;
        settled = data["settled"] == true;
        var md = data["mode"];
        if (md instanceof String) {
            mode = md;
        }
        var po = data["payOn"];
        if (po instanceof String) {
            payOn = po;
        }
        var u = data["unit"];
        if (u instanceof String) {
            unit = u;
        }
        target = toFloat(data["target"], target);
        progress = toFloat(data["progress"], progress);
        stakeTotal = toFloat(data["stakeTotal"], stakeTotal);
        goalMet = data["goalMet"] == true;
        if (finished) {
            _finishPending = false;
        }
        setField(_raisedField, raised);
        checkMilestone();
        WatchUi.requestUpdate();
    }

    function isGoalMode() as Boolean {
        return mode.equals("goal");
    }

    //! Per-km mode: one buzz each time the total crosses another milestone (every $25
    //! by default). Goal mode: one buzz when the goal is met.
    private function checkMilestone() as Void {
        if (isGoalMode()) {
            if (goalMet && !_goalBuzzed) {
                _goalBuzzed = true;
                celebrate();
            }
            return;
        }
        if (milestone <= 0) {
            return;
        }
        var reached = (raised / milestone).toNumber();
        if (reached > _lastMilestone) {
            _lastMilestone = reached;
            celebrate();
        }
    }

    private function celebrate() as Void {
        if (Attention has :vibrate) {
            Attention.vibrate([
                new Attention.VibeProfile(100, 250),
                new Attention.VibeProfile(0, 120),
                new Attention.VibeProfile(100, 250),
                new Attention.VibeProfile(0, 120),
                new Attention.VibeProfile(100, 250)
            ]);
        }
        if (Attention has :playTone) {
            Attention.playTone(Attention.TONE_SUCCESS);
        }
    }

    private function readHeartRate() as Number? {
        var info = Sensor.getInfo();
        if (info has :heartRate && info.heartRate != null) {
            return info.heartRate;
        }
        var a = Activity.getActivityInfo();
        return a != null ? a.currentHeartRate : null;
    }

    //! Lower edge of the wearer's heart-rate zone 2, from their Garmin profile.
    private function zone2Floor() as Number {
        if (UserProfile has :getHeartRateZones) {
            var zones = UserProfile.getHeartRateZones(UserProfile.HR_ZONE_SPORT_GENERIC);
            if (zones.size() >= 2) {
                return zones[1];
            }
        }
        return 100;
    }

    private function toFloat(v, fallback as Float) as Float {
        if (v instanceof Number || v instanceof Float || v instanceof Double || v instanceof Long) {
            return v.toFloat();
        }
        return fallback;
    }

    // Numeric codes rather than Communications constants, so an older SDK still compiles.
    private function describe(code as Number) as String {
        if (code == -104) {
            return "No phone";
        }
        if (code == -1001) {
            return "Needs HTTPS";
        }
        if (code == -300) {
            return "Timed out";
        }
        if (code == 401) {
            return "Wrong relay key";
        }
        if (code == 404) {
            return "Server not found";
        }
        if (code >= 500) {
            return "Server error";
        }
        if (code < 0) {
            return "No connection";
        }
        return "Error " + code;
    }

    private function readSettings() as Void {
        var url = stringProp("serverUrl", "");
        if (url.find("YOUR-SERVER") != null) {
            url = ""; // still the placeholder from properties.xml
        }
        if (url.length() > 1 && url.substring(url.length() - 1, url.length()).equals("/")) {
            url = url.substring(0, url.length() - 1);
        }
        _serverUrl = url;
        _runnerId = stringProp("runnerId", "runner-1");
        _relayKey = stringProp("relayKey", "none");
        var poll = Application.Properties.getValue("pollSeconds");
        if (poll instanceof Number && poll >= 2) {
            _pollSeconds = poll;
        }
    }

    private function stringProp(key as String, fallback as String) as String {
        var v = Application.Properties.getValue(key);
        if (v instanceof String && v.length() > 0) {
            return v;
        }
        return fallback;
    }
}
