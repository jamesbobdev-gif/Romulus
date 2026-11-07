import Foundation
import UIKit
import AVFoundation
import AudioToolbox
import Speech
import Capacitor

/// "Hey Romulus" on the iPhone (WakeWordPlugin.java + WakeWordService.java on Android). iOS lets an app
/// use the microphone only while it is open, so this listens only while Romulus is on screen, with the
/// orange microphone dot showing. Recognition runs on the phone itself (it refuses to turn on when the
/// iPhone can't do that), so no sound goes anywhere. Hearing the phrase plays a chime and calls
/// window.__tasksHook({kind:'wake'}), which starts Voice; this lets go of the mic until Voice is done.
@objc(WakeWordPlugin)
public class WakeWordPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WakeWordPlugin"
    public let jsName = "WakeWord"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openOverlaySettings", returnType: CAPPluginReturnPromise)
    ]

    private static weak var current: WakeWordPlugin?
    private static var held = false
    private static let wantedKey = "wake.on"

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var freshStart: Timer?
    private var running = false

    private var wanted: Bool {
        get { UserDefaults.standard.bool(forKey: Self.wantedKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.wantedKey) }
    }

    override public func load() {
        Self.current = self
        NotificationCenter.default.addObserver(self, selector: #selector(appActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appInactive), name: UIApplication.willResignActiveNotification, object: nil)
        DispatchQueue.main.async { self.startIfWanted() } // on from last time
    }

    /// Voice is using the mic (on) or done with it (off).
    static func hold(_ on: Bool) {
        DispatchQueue.main.async {
            held = on
            if on { current?.stopListening() } else { current?.restart(after: 0.6) }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.state()) }
    }

    @objc func enable(_ call: CAPPluginCall) {
        SpeechAccess.ask { problem in
            DispatchQueue.main.async {
                if let problem { call.reject(problem); return }
                guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), rec.supportsOnDeviceRecognition else {
                    call.reject("This iPhone can't recognize speech on the phone itself, so Hey Romulus stays off rather than send sound to Apple.")
                    return
                }
                self.wanted = true
                self.startIfWanted()
                call.resolve(self.state())
            }
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.wanted = false
            self.stopListening()
            call.resolve(self.state())
        }
    }

    /// Android's "Display over other apps" setting; there is nothing like it on the iPhone.
    @objc func openOverlaySettings(_ call: CAPPluginCall) { call.resolve() }

    private func state() -> [String: Any] {
        ["on": wanted, "running": running, "modelReady": true, "downloading": false, "overlay": true, "foregroundOnly": true]
    }

    @objc private func appActive() { startIfWanted() }

    @objc private func appInactive() {
        stopListening()
        if !Self.held { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    private func startIfWanted() {
        guard wanted, !Self.held, !running, SpeechAccess.granted,
              UIApplication.shared.applicationState == .active,
              let rec = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              rec.isAvailable, rec.supportsOnDeviceRecognition else { return }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        req.contextualStrings = ["Hey Romulus", "Romulus"]
        request = req
        do {
            let session = AVAudioSession.sharedInstance()
            // mixes with music instead of stopping it
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let input = engine.inputNode
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak req] buffer, _ in
                req?.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            request = nil
            return
        }
        running = true
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.request === req else { return }
                if let result, Self.heard(result.bestTranscription.formattedString) { self.fire(); return }
                if error != nil || result?.isFinal == true { self.restart(after: 0.5) }
            }
        }
        // one recognition's words pile up for as long as it runs: start a fresh one every 50 seconds
        freshStart = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { [weak self] _ in self?.restart(after: 0) }
    }

    /// "hey" right before "romulus", anywhere in what was heard.
    static func heard(_ text: String) -> Bool {
        let words = text.lowercased().components(separatedBy: CharacterSet.letters.inverted).filter { !$0.isEmpty }
        guard words.count >= 2 else { return false }
        for i in 0..<(words.count - 1) where words[i] == "hey" && words[i + 1] == "romulus" { return true }
        return false
    }

    private func fire() {
        stopListening()
        AudioServicesPlaySystemSound(1113) // the "begin listening" chime
        RomulusViewController.shared?.sendHook(["kind": "wake"])
        // if the page doesn't start Voice (it holds the mic when it does), listen again shortly
        restart(after: 3)
    }

    private func restart(after seconds: TimeInterval) {
        stopListening()
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.startIfWanted() }
    }

    private func stopListening() {
        freshStart?.invalidate()
        freshStart = nil
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        running = false
    }
}
