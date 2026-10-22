import type { FlashMessage, RunningAction } from "./use-action-feed";

const FLASH_STYLES = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-900",
  error: "border-red-300 bg-red-50 text-red-900",
} as const;

export function ActionFeed(input: {
  running: RunningAction[];
  flashes: FlashMessage[];
  onDismiss: (id: string) => void;
}) {
  if (input.running.length === 0 && input.flashes.length === 0) return null;

  return (
    <div
      aria-label="Action feedback"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex max-h-[60vh] flex-col-reverse gap-2 overflow-y-auto sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:w-[26rem] sm:-translate-x-1/2"
    >
      {input.running.map((action) => (
        <div
          key={action.id}
          role="status"
          className="pointer-events-auto flex items-center gap-3 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 shadow-lg"
        >
          <span
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-sky-600 border-t-transparent"
          />
          <span className="min-w-0 break-words">Running {action.label}…</span>
        </div>
      ))}

      {input.flashes.map((flash) => (
        <div
          key={flash.id}
          role={flash.kind === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-3 py-2 text-sm shadow-lg ${FLASH_STYLES[flash.kind]}`}
        >
          <p className="min-w-0 flex-1 break-words">{flash.text}</p>
          <button
            type="button"
            aria-label="Dismiss notification"
            className="shrink-0 rounded px-1 text-lg leading-none opacity-60 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => input.onDismiss(flash.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}