import { sha256Hex } from "../assets/store";
import type { EditSnapshot } from "../contracts/domain";
import { stableStringify } from "../idempotency/service";

export function buildEditCommonInputHash(snapshot: EditSnapshot): string {
  return sha256Hex(
    Buffer.from(
      stableStringify({
        operation: "edit",
        parentVersionId: snapshot.parentVersionId,
        sourceAssetId: snapshot.sourceAssetId,
        sourceSha256: snapshot.sourceSha256,
        sourceWidth: snapshot.sourceWidth,
        sourceHeight: snapshot.sourceHeight,
        selectionId: snapshot.selectionId,
        selectionSourceVersionId: snapshot.selectionSourceVersionId,
        binaryMaskAssetId: snapshot.binaryMaskAssetId,
        binaryMaskSha256: snapshot.binaryMaskSha256,
        paddingPx: snapshot.paddingPx,
        featherPx: snapshot.featherPx,
        allowedMaskAssetId: snapshot.allowedMaskAssetId,
        allowedMaskSha256: snapshot.allowedMaskSha256,
        blendMaskAssetId: snapshot.blendMaskAssetId,
        blendMaskSha256: snapshot.blendMaskSha256,
        regionBoundingBox: snapshot.regionBoundingBox,
        regionPercentages: snapshot.regionPercentages,
        targetLabel: snapshot.targetLabel,
        instruction: snapshot.instruction,
        prompt: snapshot.prompt,
        promptVersion: snapshot.promptVersion,
        referenceAssetIds: snapshot.referenceAssetIds,
        referenceSha256: snapshot.referenceSha256,
        normalizationVersion: snapshot.normalizationVersion,
        maskPipelineVersion: snapshot.maskPipelineVersion,
        transportOptions: snapshot.transportOptions,
      }),
      "utf8",
    ),
  );
}
