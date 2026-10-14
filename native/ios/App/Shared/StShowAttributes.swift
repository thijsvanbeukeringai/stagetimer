import ActivityKit
import Foundation

// The Live Activity's data. Compiled into BOTH the App target (which starts
// and updates the activity through StLiveActivityPlugin) and the
// StagetimerLiveActivity widget extension (which draws it). ActivityKit
// matches the two by type name and Codable shape, so any change here must
// ship in both at once: keep this the single definition.
struct StShowAttributes: ActivityAttributes {
    // Static for the lifetime of one activity: a stage switch starts a new one.
    var stageName: String

    struct ContentState: Codable, Hashable {
        var showName: String
        var nextName: String?
        // Device-clock instants. The web app converts its server-corrected
        // times back to the device clock, because iOS ticks the countdown
        // on its own clock without any update from the app.
        var startsAt: Date
        var endsAt: Date
        // "live" (counting down to endsAt), "upcoming" (counting down to
        // startsAt), "paused" / "ready" (manual timer, frozen at pausedAt).
        var phase: String
        // Manual timer past its deadline (counts up, red).
        var overrun: Bool
        // Countdown comes from the operator's manual timer, not the schedule:
        // past endsAt it is overtime, where a scheduled show has simply ended.
        var manual: Bool
        var pausedAt: Date?
    }
}
