import ActivityKit
import SwiftUI
import WidgetKit

// Lock screen + Dynamic Island for the show countdown (BOUWPLAN phase 6,
// step 4). The data type is Shared/StShowAttributes.swift; the app starts
// and updates the activity (StLiveActivityPlugin). Every countdown here is a
// Text/ProgressView with a timer interval, so iOS keeps it ticking while the
// app (and its web view) is suspended. Colours are the booth's: tColor()
// in app.html (#22c55e green, #ef4444 red) on the app's #0b0b0e.

@main
struct StagetimerLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        StShowLiveActivity()
    }
}

private enum Palette {
    static let background = Color(red: 0x0b / 255, green: 0x0b / 255, blue: 0x0e / 255)
    static let green = Color(red: 0x22 / 255, green: 0xc5 / 255, blue: 0x5e / 255)
    static let red = Color(red: 0xef / 255, green: 0x44 / 255, blue: 0x44 / 255)
    static let sub = Color.white.opacity(0.55)
    static let dim = Color.white.opacity(0.35)
}

// What the countdown shows right now. isStale is set by iOS at the stale date
// the app passed (end of the show, start of the next one), so these flip
// without the app running.
private enum Mode {
    case live, overtime, ended, upcoming, starting, paused, ready

    init(_ state: StShowAttributes.ContentState, stale: Bool) {
        switch state.phase {
        case "upcoming": self = stale ? .starting : .upcoming
        case "paused": self = .paused
        case "ready": self = .ready
        default:
            if state.overrun { self = .overtime }
            else if stale { self = state.manual ? .overtime : .ended }
            else { self = .live }
        }
    }

    var label: String {
        switch self {
        case .live: return "LIVE"
        case .overtime: return "OVERTIME"
        case .ended: return "ENDED"
        case .upcoming: return "STARTS IN"
        case .starting: return "STARTING"
        case .paused: return "PAUSED"
        case .ready: return "READY"
        }
    }

    var color: Color {
        switch self {
        case .live: return Palette.green
        case .overtime: return Palette.red
        case .ended, .starting: return Palette.sub
        case .upcoming, .paused, .ready: return .white
        }
    }
}

// Frozen value for a paused / ready manual timer, as the operator panel shows
// it (s2cdH: m:ss below an hour, h:mm:ss above; "+" in overtime).
private func frozenText(_ state: StShowAttributes.ContentState) -> String {
    let at = state.pausedAt ?? state.startsAt
    let rem = Int(state.endsAt.timeIntervalSince(at).rounded(.up))
    let a = abs(rem), h = a / 3600, m = (a % 3600) / 60, s = a % 60
    let body = h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    return (rem < 0 ? "+" : "") + body
}

private struct Countdown: View {
    let state: StShowAttributes.ContentState
    let mode: Mode

    var body: some View {
        Group {
            switch mode {
            case .live:
                Text(timerInterval: state.startsAt...state.endsAt, countsDown: true)
            case .overtime:
                // style .timer counts up once the date has passed.
                Text("+") + Text(state.endsAt, style: .timer)
            case .ended:
                Text("00:00")
            case .upcoming:
                Text(state.startsAt, style: .timer)
            case .starting:
                Text("Now")
            case .paused, .ready:
                Text(frozenText(state))
            }
        }
        .monospacedDigit()
        .foregroundColor(mode.color)
    }
}

private struct Progress: View {
    let state: StShowAttributes.ContentState
    let mode: Mode

    var body: some View {
        Group {
            switch mode {
            case .live:
                ProgressView(timerInterval: state.startsAt...state.endsAt, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
            case .paused, .ready:
                let total = state.endsAt.timeIntervalSince(state.startsAt)
                let done = (state.pausedAt ?? state.startsAt).timeIntervalSince(state.startsAt)
                ProgressView(value: min(max(done, 0), total), total: total)
            case .overtime, .ended:
                ProgressView(value: 1, total: 1)
            case .upcoming, .starting:
                ProgressView(value: 0, total: 1)
            }
        }
        .progressViewStyle(.linear)
        .tint(mode == .overtime ? Palette.red : mode == .live ? Palette.green : Palette.dim)
    }
}

private struct UpNext: View {
    let name: String?
    var body: some View {
        if let name {
            (Text("Up next: ").foregroundColor(Palette.dim) + Text(name).foregroundColor(Palette.sub))
                .font(.caption)
                .lineLimit(1)
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<StShowAttributes>

    var body: some View {
        let state = context.state
        let mode = Mode(state, stale: context.isStale)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(context.attributes.stageName.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(1.5)
                    .foregroundColor(Palette.dim)
                    .lineLimit(1)
                Spacer()
                Text(mode.label)
                    .font(.caption2.weight(.heavy))
                    .tracking(1)
                    .foregroundColor(mode.color)
            }
            HStack(alignment: .center, spacing: 12) {
                Text(state.showName)
                    .font(.title3.weight(.heavy))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 4)
                Countdown(state: state, mode: mode)
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 150, alignment: .trailing)
            }
            Progress(state: state, mode: mode)
            UpNext(name: state.nextName)
        }
        .padding(16)
    }
}

struct StShowLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: StShowAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(Palette.background)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            let mode = Mode(state, stale: context.isStale)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.stageName.uppercased())
                            .font(.caption2.weight(.bold))
                            .foregroundColor(Palette.dim)
                            .lineLimit(1)
                        Text(mode.label)
                            .font(.caption2.weight(.heavy))
                            .foregroundColor(mode.color)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Countdown(state: state, mode: mode)
                        .font(.system(size: 26, weight: .bold, design: .rounded))
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 120, alignment: .trailing)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(state.showName)
                            .font(.headline.weight(.heavy))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Progress(state: state, mode: mode)
                        UpNext(name: state.nextName)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Text(state.showName)
                    .font(.caption.weight(.bold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .frame(maxWidth: 64, alignment: .leading)
            } compactTrailing: {
                Countdown(state: state, mode: mode)
                    .font(.caption.weight(.bold))
                    .multilineTextAlignment(.trailing)
                    .frame(width: 52, alignment: .trailing)
            } minimal: {
                Countdown(state: state, mode: mode)
                    .font(.system(size: 11, weight: .bold))
                    .minimumScaleFactor(0.6)
                    .multilineTextAlignment(.center)
                    .frame(width: 36)
            }
            .keylineTint(mode.color)
        }
    }
}
