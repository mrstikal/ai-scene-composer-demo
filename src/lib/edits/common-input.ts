import { sha256Hex } from "../assets/store";
import type { EditSnapshot } from "../contracts/domain";
import { stableStringify } from "../idempotency/service";

export function buildEditCommonInputHash(snapshot: EditSnapshot): string {
  return sha256Hex(
    Buffer.from(
      stableStringify({
        operation: "edit",
        scope: snapshot.scope,
        parentVersionId: snapshot.parentVersionId,
        sourceAssetId: snapshot.sourceAssetId,
        sourceSha256: snapshot.sourceSha256,
        sourceWidth: snapshot.sourceWidth,
        sourceHeight: snapshot.sourceHeight,
        selectionId: snapshot.selectionId ?? null,
        selectionSourceVersionId: snapshot.selectionSourceVersionId ?? null,
        binaryMaskAssetId: snapshot.binaryMaskAssetId ?? null,
        binaryMaskSha256: snapshot.binaryMaskSha256 ?? null,
        paddingPx: snapshot.paddingPx ?? null,
        featherPx: snapshot.featherPx ?? null,
        allowedMaskAssetId: snapshot.allowedMaskAssetId ?? null,
        allowedMaskSha256: snapshot.allowedMaskSha256 ?? null,
        blendMaskAssetId: snapshot.blendMaskAssetId ?? null,
        blendMaskSha256: snapshot.blendMaskSha256 ?? null,
        regionBoundingBox: snapshot.regionBoundingBox ?? null,
        regionPercentages: snapshot.regionPercentages ?? null,
        targetLabel: snapshot.targetLabel ?? null,
        instruction: snapshot.instruction,
        prompt: snapshot.prompt,
        promptVersion: snapshot.promptVersion,
        referenceAssetIds: snapshot.referenceAssetIds,
        referenceSha256: snapshot.referenceSha256,
        normalizationVersion: snapshot.normalizationVersion,
        maskPipelineVersion: snapshot.maskPipelineVersion ?? null,
        transportOptions: snapshot.transportOptions,
      }),
      "utf8",
    ),
  );
}
