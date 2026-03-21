import { useEffect, useRef } from 'react';
import { useNotificationStore } from '../store/notification-store';

export function useNotifications() {
  const { setNotification } = useNotificationStore();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Create audio element for notification chime.
    // Generate a minimal WAV beep as a data URI (440Hz, 100ms)
    const audio = new Audio();
    const sampleRate = 8000;
    const duration = 0.1;
    const samples = sampleRate * duration;
    const buffer = new ArrayBuffer(44 + samples);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeString(36, 'data');
    view.setUint32(40, samples, true);
    for (let i = 0; i < samples; i++) {
      view.setUint8(44 + i, 128 + 64 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    }
    const blob = new Blob([buffer], { type: 'audio/wav' });
    audio.src = URL.createObjectURL(blob);
    audio.volume = 0.3;
    audioRef.current = audio;
  }, []);

  useEffect(() => {
    const cleanup = window.fleet.notifications.onNotification((payload) => {
      setNotification({
        paneId: payload.paneId,
        level: payload.level,
        timestamp: payload.timestamp
      });

      // Play sound for permission notifications (default behavior)
      if (payload.level === 'permission' && audioRef.current) {
        audioRef.current.play().catch(() => {
          // Audio play may be blocked by browser autoplay policy — ignore
        });
      }
    });
    return () => {
      cleanup();
    };
  }, [setNotification]);
}
