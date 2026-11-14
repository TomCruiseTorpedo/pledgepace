import Toybox.Lang;
import Toybox.WatchUi;

//! YES saves the run and reports it finished. NO keeps the run, paused: press START
//! to carry on. Nothing is ever thrown away from this prompt.
class FinishDelegate extends WatchUi.ConfirmationDelegate {
    private var _s as PledgeSession;

    function initialize(session as PledgeSession) {
        ConfirmationDelegate.initialize();
        _s = session;
    }

    function onResponse(response as WatchUi.Confirm) as Boolean {
        if (response == WatchUi.CONFIRM_YES) {
            _s.finish();
        }
        return true;
    }
}
