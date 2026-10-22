"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type FlashKind = "success" | "error";

export interface FlashMessage {
  id: string;
  kind: FlashKind;
  text: string;
}

export interface RunningAction {
  id: string;
  label: string;
}

export const SUCCESS_FLASH_MS = 3_000;
const MAX_FLASHES = 5;

export function useActionFeed() {
  const [flashes, setFlashes] = useState<FlashMessage[]>([]);
  const flashesRef = useRef<FlashMessage[]>([]);
  const sequence = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const commit = useCallback((next: FlashMessage[]) => {
    flashesRef.current = next;
    setFlashes(next);
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      const timer = timers.current.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
      commit(flashesRef.current.filter((flash) => flash.id !== id));
    },
    [commit],
  );

  const push = useCallback(
    (kind: FlashKind, text: string, autoCloseMs: number | null) => {
      const message = text.trim();
      if (message.length === 0) return;

      const existing = flashesRef.current.find(
        (flash) => flash.kind === kind && flash.text === message,
      );
      const id = existing?.id ?? `flash-${++sequence.current}`;

      const previousTimer = timers.current.get(id);
      if (previousTimer !== undefined) {
        clearTimeout(previousTimer);
        timers.current.delete(id);
      }

      const next = existing === undefined
        ? [...flashesRef.current, { id, kind, text: message }]
        : flashesRef.current;
      const kept = next.slice(-MAX_FLASHES);
      for (const flash of next) {
        if (kept.every((value) => value.id !== flash.id)) {
          const timer = timers.current.get(flash.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.current.delete(flash.id);
          }
        }
      }
      commit(kept);

      if (autoCloseMs !== null) {
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            commit(flashesRef.current.filter((flash) => flash.id !== id));
          }, autoCloseMs),
        );
      }
    },
    [commit],
  );

  const showSuccess = useCallback(
    (text: string) => push("success", text, SUCCESS_FLASH_MS),
    [push],
  );
  const showError = useCallback((text: string) => push("error", text, null), [push]);

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      for (const timer of activeTimers.values()) clearTimeout(timer);
      activeTimers.clear();
    };
  }, []);

  return { flashes, showSuccess, showError, dismiss };
}