package com.jartro.tasks;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Voice → text for "add a task by talking": Android's own speech recognizer, no popup. listen()
 * resolves with {text} once you stop speaking ("" if nothing was caught); "partial" events stream
 * the words as you say them so the box can show them live.
 */
@CapacitorPlugin(name = "Voice", permissions = {
        @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "mic")})
public class VoicePlugin extends Plugin {
    private SpeechRecognizer recognizer;
    private PluginCall active;

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micPermission");
            return;
        }
        start(call);
    }

    @PermissionCallback
    private void micPermission(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) start(call);
        else call.reject("Microphone permission is off — allow it for Tasks in Android settings.");
    }

    /** Stop listening now and use what was heard so far. */
    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    private void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("Speech recognition isn't available on this phone (is the Google app installed?)");
                return;
            }
            release();
            active = call;
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onReadyForSpeech(Bundle params) { notifyListeners("ready", new JSObject()); }
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() { notifyListeners("end", new JSObject()); }
                @Override public void onEvent(int eventType, Bundle params) {}

                @Override public void onPartialResults(Bundle b) {
                    String t = first(b);
                    if (t != null && !t.isEmpty()) { JSObject o = new JSObject(); o.put("text", t); notifyListeners("partial", o); }
                }

                @Override public void onResults(Bundle b) {
                    String t = first(b);
                    JSObject o = new JSObject();
                    o.put("text", t == null ? "" : t);
                    finish(o, null);
                }

                @Override public void onError(int error) {
                    // silence / nothing recognized isn't a failure: you just get no task
                    if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        JSObject o = new JSObject(); o.put("text", ""); finish(o, null);
                    } else finish(null, describe(error));
                }
            });
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            // a short pause shouldn't cut you off mid-sentence
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500);
            i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1500);
            recognizer.startListening(i);
        });
    }

    private void finish(JSObject result, String error) {
        PluginCall c = active;
        active = null;
        getActivity().runOnUiThread(this::release);
        if (c == null) return;
        if (error != null) c.reject(error); else c.resolve(result);
    }

    private void release() {
        if (recognizer != null) { try { recognizer.destroy(); } catch (Exception ignored) {} recognizer = null; }
    }

    private static String first(Bundle b) {
        if (b == null) return null;
        ArrayList<String> m = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (m == null || m.isEmpty()) ? null : m.get(0);
    }

    private static String describe(int e) {
        switch (e) {
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "No connection for speech recognition";
            case SpeechRecognizer.ERROR_AUDIO: return "Couldn't use the microphone";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "Microphone permission is off";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "The speech recognizer is busy — try again";
            default: return "Speech recognition failed (" + e + ")";
        }
    }

    @Override
    protected void handleOnDestroy() { release(); }
}
