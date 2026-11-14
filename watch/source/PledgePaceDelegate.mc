import Toybox.Lang;
import Toybox.WatchUi;

//! START (or a tap) starts, pauses and resumes. BACK with a run in progress asks
//! whether to finish it, which saves the activity and tells the server to settle.
class PledgePaceDelegate extends WatchUi.BehaviorDelegate {
    private var _s as PledgeSession;

    function initialize(session as PledgeSession) {
        BehaviorDelegate.initialize();
        _s = session;
    }

    function onSelect() as Boolean {
        if (_s.isRecording()) {
            _s.pause();
        } else {
            _s.startOrResume();
        }
        WatchUi.requestUpdate();
        return true;
    }

    function onBack() as Boolean {
        if (_s.hasActivity()) {
            _s.pause();
            var prompt = WatchUi.loadResource(Rez.Strings.FinishPrompt) as String;
            WatchUi.pushView(new WatchUi.Confirmation(prompt), new FinishDelegate(_s), WatchUi.SLIDE_IMMEDIATE);
            return true;
        }
        return false; // nothing recorded, so BACK exits the app
    }
}
