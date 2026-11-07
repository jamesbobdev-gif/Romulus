import Foundation
import AVFoundation
import Speech
import Capacitor

/// Microphone + speech recognition permission, asked once for both Voice and WakeWord.
enum SpeechAccess {
    static var granted: Bool {
        SFSpeechRecognizer.authorizationStatus() == .authorized && AVAudioSession.sharedInstance().recordPermission == .granted
    }

    /// nil when both are allowed, else what to tell him.
    static func ask(_ done: @escaping (String?) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                done("Speech recognition is off for Romulus. Turn it on in Settings > Romulus.")
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { ok in
                done(ok ? nil : "Microphone access is off for Romulus. Turn it on in Settings > Romulus.")
            }
        }
    }

    static func recognizer() -> SFSpeechRecognizer? {
        SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }
}

/// Voice to text for "add a task by talking" (VoicePlugin.java on Android). listen() resolves with {text}
/// once he stops speaking ("" if nothing was caught); "partial" events stream the words as he says them.
/// On the phone itself when the iPhone can do that, so the sound doesn't go to Apple.
@objc(VoicePlugin)
public class VoicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoicePlugin"
    public let jsName = "Voice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var active: CAPPluginCall?
    private var lastText = ""
    private var silence: Timer?

    @objc func listen(_ call: CAPPluginCall) {
        SpeechAccess.ask { problem in
            DispatchQueue.main.async {
                if let problem { call.reject(problem) } else { self.start(call) }
            }
        }
    }

    /// Stop listening now and use what was heard so far.
    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.active != nil { self.endAudio(for: self.request) }
            call.resolve()
        }
    }

    private func start(_ call: CAPPluginCall) {
        guard let rec = SpeechAccess.recognizer(), rec.isAvailable else {
            call.reject("Speech recognition isn't available right now. Check the connection and try again.")
            return
        }
        if let previous = active { active = nil; previous.resolve(["text": lastText]) }
        teardown()
        WakeWordPlugin.hold(true) // "Hey Romulus" lets go of the mic while this listens
        active = call
        lastText = ""

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        if #available(iOS 16.0, *) { req.addsPunctuation = true }
        request = req
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak req] buffer, _ in
                req?.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            finish(text: nil, error: "Couldn't use the microphone")
            return
        }
        notifyListeners("ready", data: [:])
        armSilence(5, for: req) // nothing said at all: stop after a few seconds

        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.request === req else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if !text.isEmpty {
                        self.lastText = text
                        self.notifyListeners("partial", data: ["text": text])
                        self.armSilence(1.5, for: req) // a short pause shouldn't cut him off mid-sentence
                    }
                    if result.isFinal { self.finish(text: text.isEmpty ? self.lastText : text, error: nil); return }
                }
                // silence or nothing recognized isn't a failure: he just gets no task
                if error != nil { self.finish(text: self.lastText, error: nil) }
            }
        }
    }

    private func armSilence(_ seconds: TimeInterval, for req: SFSpeechAudioBufferRecognitionRequest) {
        silence?.invalidate()
        silence = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.endAudio(for: req)
        }
    }

    /// No more sound: the recognizer then sends its final words. If it never does, what was heard is used.
    private func endAudio(for req: SFSpeechAudioBufferRecognitionRequest?) {
        guard let req, request === req else { return }
        silence?.invalidate()
        notifyListeners("end", data: [:])
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        req.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.request === req else { return }
            self.finish(text: self.lastText, error: nil)
        }
    }

    private func finish(text: String?, error: String?) {
        silence?.invalidate()
        silence = nil
        let call = active
        active = nil
        teardown()
        WakeWordPlugin.hold(false)
        guard let call else { return }
        if let error { call.reject(error) } else { call.resolve(["text": text ?? ""]) }
    }

    private func teardown() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
