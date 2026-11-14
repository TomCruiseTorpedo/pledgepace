import Toybox.Application;
import Toybox.Background;
import Toybox.Lang;
import Toybox.System;
import Toybox.Time;
import Toybox.WatchUi;

//! Entry point. Owns the one PledgeSession that the view and delegate share, and schedules
//! the background check that nudges you while the app is closed. Annotated (:background)
//! because Connect IQ loads the app class in the background process too.
(:background)
class PledgePaceApp extends Application.AppBase {
    private var _session as PledgeSession?;

    function initialize() {
        AppBase.initialize();
    }

    function onStart(state as Dictionary?) as Void {
    }

    //! Save rather than lose a run if the app is closed mid-activity.
    function onStop(state as Dictionary?) as Void {
        if (_session != null) {
            _session.shutdown();
        }
    }

    function getInitialView() as [Views] or [Views, InputDelegates] {
        // Every 5 minutes, the shortest interval Connect IQ allows; re-registering just replaces it.
        if (Toybox has :Background) {
            Background.registerForTemporalEvent(new Time.Duration(5 * 60));
        }
        var session = new PledgeSession();
        _session = session;
        return [new PledgePaceView(session), new PledgePaceDelegate(session)];
    }

    function getServiceDelegate() as [System.ServiceDelegate] {
        return [new NudgeServiceDelegate()];
    }
}
