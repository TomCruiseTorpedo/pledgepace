import Toybox.ActivityMonitor;
import Toybox.Application;
import Toybox.Background;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.Notifications;
import Toybox.System;

//! Runs in the background every 5 minutes, even while PledgePace is closed. It reports the
//! watch's step and floor counts and shows whatever the server says is worth a notification:
//! a new backer, the goal just met, or a reminder of the money still at stake. The server
//! remembers what it has already announced, because a background task cannot write storage.
(:background)
class NudgeServiceDelegate extends System.ServiceDelegate {
    function initialize() {
        ServiceDelegate.initialize();
    }

    function onTemporalEvent() as Void {
        var url = prop("serverUrl", "");
        if (url.length() == 0 || url.find("YOUR-SERVER") != null) {
            Background.exit(null); // not configured yet
            return;
        }
        if (url.substring(url.length() - 1, url.length()).equals("/")) {
            url = url.substring(0, url.length() - 1);
        }
        var body = {} as Dictionary<Object, Object>;
        var am = ActivityMonitor.getInfo();
        if (am.steps != null) {
            body["steps"] = am.steps;
        }
        if (am has :floorsClimbed && am.floorsClimbed != null) {
            body["floors"] = am.floorsClimbed;
        }
        Communications.makeWebRequest(
            url + "/api/runs/" + prop("runnerId", "runner-1") + "/nudge",
            body,
            {
                :method => Communications.HTTP_REQUEST_METHOD_POST,
                :headers => {
                    "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON,
                    "X-Relay-Key" => prop("relayKey", "none")
                },
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            },
            method(:onNudge)
        );
    }

    function onNudge(code as Number, data as Dictionary or String or Null) as Void {
        if (code == 200 && data instanceof Dictionary) {
            var title = data["title"];
            var text = data["body"];
            if (title instanceof String && text instanceof String) {
                show(title, text);
            }
        }
        Background.exit(null);
    }

    //! A real notification where the watch supports them (API 5.1 and later); otherwise a
    //! prompt asking to open the app, which older watches do support from the background.
    private function show(title as String, text as String) as Void {
        if (Toybox has :Notifications) {
            Notifications.showNotification(title, text, {});
        } else {
            Background.requestApplicationWake(title + ": " + text);
        }
    }

    private function prop(key as String, fallback as String) as String {
        var v = Application.Properties.getValue(key);
        if (v instanceof String && v.length() > 0) {
            return v;
        }
        return fallback;
    }
}
