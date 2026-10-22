import type { ResponsesEvent } from "@meta-sam/parser";
import { describe, expect, it } from "vitest";

import { buildSamPrompt, parseSamEvents } from "@/lib/providers/sam";
import documented from "@/test/fixtures/providers/sam/documented-complete-output-line.json";

const documentedInput = {
  width: 320,
  height: 334,
  positive: { x: 180, y: 240 },
  negative: null,
};

async function* eventStream(
  events: readonly ResponsesEvent[],
): AsyncIterable<ResponsesEvent> {
  for (const event of events) yield event;
}

function documentedEvents(completed = true): ResponsesEvent[] {
  const outputText = documented.outputText;
  const split = outputText.indexOf(",1<|box");
  const events: ResponsesEvent[] = [
    {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(0, split),
    },
    {
      type: "response.output_text.delta",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      delta: outputText.slice(split),
    },
    {
      type: "response.output_text.done",
      item_id: "message-1",
      output_index: 0,
      content_index: 0,
      text: outputText,
    },
  ];

  if (completed) {
    events.push({
      type: "response.completed",
      response: { id: "req_documentation", usage: { cost: 0.0025 } },
    } as unknown as ResponsesEvent);
  }
  return events;
}

describe("SAM prompt construction", () => {
  it("builds the exact official object prompt for one positive point", () => {
    expect(
      buildSamPrompt({
        width: 1024,
        height: 1024,
        positive: { x: 100, y: 200 },
        negative: null,
      }),
    ).toBe("<0f>1<|point;x=100;y=200;w=1024;h=1024|>");
  });

  it("builds the exact official object prompt for a positive and negative point", () => {
    expect(
      buildSamPrompt({
        width: 1024,
        height: 1024,
        positive: { x: 100, y: 200 },
        negative: { x: 300, y: 400 },
      }),
    ).toBe(
      "<0f>1<|point;x=100;y=200;w=1024;h=1024|>-<|point;x=300;y=400;w=1024;h=1024|>",
    );
  });
});

describe("SAM stream parsing and mask placement", () => {
  it("parses the documented complete stream for object 1 and preserves terminal metadata", async () => {
    const result = await parseSamEvents(eventStream(documentedEvents()), documentedInput);
    if (result.kind !== "mask" || result.representation !== "sam-records") {
      throw new Error(`Expected a SAM mask, got ${result.kind}.`);
    }

    expect(result.representation).toBe("sam-records");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.objectId).toBe("1");
    expect(result.records[0]?.box).toEqual({ left: 155, top: 228, right: 203, bottom: 255 });
    expect(result.width).toBe(320);
    expect(result.height).toBe(334);
    expect(result.fullMask[240 * 320 + 180]).toBe(1);
    expect(result.providerRequestId).toBe("req_documentation");
    expect(result.observedCostUsdMicros).toBe(2500);
    expect(result.latencyMs).not.toBeNull();
  });

  it("treats an EOF without a completion event as ambiguous", async () => {
    const result = await parseSamEvents(
      eventStream(documentedEvents(false)),
      documentedInput,
    );
    if (result.kind !== "ambiguous") throw new Error(`Expected ambiguity, got ${result.kind}.`);
    expect(result.providerRequestId).toBeNull();
    expect(result.latencyMs).toBeNull();
  });

  it("maps a definitive failed response to rejected", async () => {
    const events: ResponsesEvent[] = [
      {
        type: "response.failed",
        response: { error: { message: "The request was blocked." } },
      },
    ];
    const result = await parseSamEvents(eventStream(events), documentedInput);
    if (result.kind !== "rejected") throw new Error(`Expected rejection, got ${result.kind}.`);
    expect(result.message).toBe("Meta SAM rejected the segmentation request.");
    expect(result.message).not.toContain("blocked");
  });

  it("rejects a completed response whose mask does not cover the positive point", async () => {
    const result = await parseSamEvents(eventStream(documentedEvents()), {
      ...documentedInput,
      positive: { x: 10, y: 10 },
    });
    if (result.kind !== "invalid") throw new Error(`Expected invalid selection, got ${result.kind}.`);
    expect(result.message).toContain("positive point");
  });

  it("rejects a completed response whose mask covers the negative point", async () => {
    const result = await parseSamEvents(eventStream(documentedEvents()), {
      ...documentedInput,
      negative: { x: 180, y: 241 },
    });
    if (result.kind !== "invalid") throw new Error(`Expected invalid selection, got ${result.kind}.`);
    expect(result.message).toContain("negative point");
  });
});
