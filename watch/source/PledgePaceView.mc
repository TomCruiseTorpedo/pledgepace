import Toybox.Activity;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.System;
import Toybox.WatchUi;

//! One screen: dollars raised is the hero, with rate, sponsors and distance under it.
//! Positions are fractions of the screen so it works from 218 px to 454 px.
class PledgePaceView extends WatchUi.View {
    private var _s as PledgeSession;

    function initialize(session as PledgeSession) {
        View.initialize();
        _s = session;
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var center = Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER;
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();

        var km = "0.00";
        var time = "0:00";
        var dist = _s.distance();
        if (dist != null) {
            km = (dist / 1000.0).format("%.2f");
        }
        var ms = _s.timerMs();
        if (ms != null) {
            time = formatTime(ms);
        }

        var state = "PRESS START";
        var stateColor = Graphics.COLOR_ORANGE;
        if (_s.settled) {
            state = "SETTLED";
            stateColor = Graphics.COLOR_GREEN;
        } else if (_s.finished) {
            state = "FINISHED";
            stateColor = Graphics.COLOR_GREEN;
        } else if (_s.isRecording()) {
            state = "RUNNING";
            stateColor = Graphics.COLOR_GREEN;
        } else if (_s.hasActivity()) {
            state = "PAUSED";
        }
        dc.setColor(stateColor, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h * 0.15, Graphics.FONT_XTINY, state, center);

        if (_s.isGoalMode()) {
            drawGoal(dc, w, h, center);
        } else {
            // FONT_LARGE rather than a number font: number fonts may not contain "$".
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.35, Graphics.FONT_LARGE, "$" + _s.raised.format("%.2f"), center);
            dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.48, Graphics.FONT_XTINY, "RAISED", center);

            dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.59, Graphics.FONT_TINY,
                "$" + _s.ratePerKm.format("%.2f") + "/km  " + _s.pledgers.toString() + " spons.", center);
        }
        // Goals measured by a sensor other than GPS show live heart rate here instead.
        var left = km;
        var leftLabel = "KM";
        if (_s.isGoalMode() && !_s.unit.equals("km")) {
            var bpm = _s.heartRate;
            left = bpm != null ? bpm.toString() : "--";
            leftLabel = "BPM";
        }
        dc.drawText(w * 0.32, h * 0.72, Graphics.FONT_SMALL, left, center);
        dc.drawText(w * 0.68, h * 0.72, Graphics.FONT_SMALL, time, center);
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w * 0.32, h * 0.80, Graphics.FONT_XTINY, leftLabel, center);
        dc.drawText(w * 0.68, h * 0.80, Graphics.FONT_XTINY, "TIME", center);

        var linkY = h * 0.90;
        var linkColor = Graphics.COLOR_RED;
        if (_s.linkStatus.equals("Linked")) {
            linkColor = _s.gpsReady ? Graphics.COLOR_GREEN : Graphics.COLOR_ORANGE;
        }
        dc.setColor(linkColor, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, linkY, Graphics.FONT_XTINY, statusLine(dc, linkY), center);
    }

    //! Goal mode: a progress ring on the bezel, money still at stake as the hero
    //! (or GOAL MET), and progress toward the goal under it.
    private function drawGoal(dc as Graphics.Dc, w as Number, h as Number, center as Number) as Void {
        var frac = _s.target > 0 ? _s.progress / _s.target : 0.0;
        if (frac > 1.0) {
            frac = 1.0;
        }
        var r = (w < h ? w : h) / 2 - 4;
        if (dc has :setPenWidth) {
            dc.setPenWidth(6);
        }
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawCircle(w / 2, h / 2, r);
        if (frac >= 0.999) {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawCircle(w / 2, h / 2, r);
        } else if (frac > 0.005) {
            // 0 degrees is 3 o'clock; start at 12 o'clock and go clockwise.
            var end = 90 - (360 * frac).toNumber();
            if (end < 0) {
                end += 360;
            }
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawArc(w / 2, h / 2, r, Graphics.ARC_CLOCKWISE, 90, end);
        }
        if (dc has :setPenWidth) {
            dc.setPenWidth(1);
        }

        var heroY = h * 0.35;
        if (_s.goalMet) {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, heroY, Graphics.FONT_LARGE, fit(dc, Graphics.FONT_LARGE, heroY, "GOAL MET", "GOAL!"), center);
            dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.48, Graphics.FONT_XTINY, "$" + _s.stakeTotal.format("%.2f") + " SAVED", center);
        } else {
            dc.setColor(Graphics.COLOR_ORANGE, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, heroY, Graphics.FONT_LARGE, "$" + _s.raised.format("%.2f"), center);
            dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w / 2, h * 0.48, Graphics.FONT_XTINY, "AT STAKE", center);
        }

        var lineY = h * 0.59;
        var progress = amount(_s.progress) + "/" + amount(_s.target) + " " + unitLabel();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, lineY, Graphics.FONT_TINY,
            fit(dc, Graphics.FONT_TINY, lineY, progress + "  " + _s.pledgers.toString() + (_s.pledgers == 1 ? " backer" : " backers"), progress), center);
    }

    private function amount(x as Float) as String {
        return _s.unit.equals("km") ? x.format("%.1f") : x.toNumber().toString();
    }

    private function unitLabel() as String {
        return _s.unit.equals("minutes") ? "min" : _s.unit;
    }

    //! The long text if it fits the screen width at height y, otherwise the short one.
    private function fit(dc as Graphics.Dc, font as Graphics.FontType, y as Float, long as String, short as String) as String {
        return dc.getTextWidthInPixels(long, font) <= usableWidth(dc, y) ? long : short;
    }

    //! Link status plus a GPS warning, shortened to fit: near the bottom of a
    //! round screen the usable width is much less than the screen width.
    private function statusLine(dc as Graphics.Dc, y as Float) as String {
        var link = _s.linkStatus;
        if (_s.gpsReady) {
            return link;
        }
        var both = link + " - no GPS";
        if (dc.getTextWidthInPixels(both, Graphics.FONT_XTINY) <= usableWidth(dc, y)) {
            return both;
        }
        // A link problem matters more than GPS; when linked, say what is missing.
        return link.equals("Linked") ? "No GPS" : link;
    }

    //! Chord width of a round screen at height y, less a margin. Full width otherwise.
    private function usableWidth(dc as Graphics.Dc, y as Float) as Float {
        var w = dc.getWidth().toFloat();
        if (System.getDeviceSettings().screenShape != System.SCREEN_SHAPE_ROUND) {
            return w * 0.9;
        }
        var r = w / 2.0;
        var dy = y - dc.getHeight() / 2.0;
        var sq = r * r - dy * dy;
        if (sq <= 0.0) {
            return 0.0;
        }
        return 2.0 * Math.sqrt(sq).toFloat() * 0.9;
    }

    private function formatTime(ms as Number) as String {
        var s = ms / 1000;
        var h = s / 3600;
        var m = (s % 3600) / 60;
        var sec = s % 60;
        if (h > 0) {
            return Lang.format("$1$:$2$:$3$", [h, m.format("%02d"), sec.format("%02d")]);
        }
        return Lang.format("$1$:$2$", [m, sec.format("%02d")]);
    }
}
