#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');

const failures = [];

function fail(message) {
  failures.push(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function closeTo(actual, expected, label) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > 1e-12) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
}

function includes(values, expected, label) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    fail(`${label}: expected to include ${JSON.stringify(expected)}`);
  }
}

function readJson(relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    fail(`${relativePath}: file does not exist`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`${relativePath}: invalid JSON (${error.message})`);
    return undefined;
  }
}

function walkJsonFiles(directory) {
  const results = [];
  if (!existsSync(directory)) return results;
  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry);
    if (statSync(absolutePath).isDirectory()) {
      results.push(...walkJsonFiles(absolutePath));
    } else if (entry.endsWith('.json')) {
      results.push(absolutePath);
    }
  }
  return results;
}

function assertNoSensitiveFixtureContent(fixture, label) {
  const serialized = JSON.stringify(fixture);
  const patterns = [
    [/["']?authorization["']?\s*:/i, 'authorization header'],
    [/Bearer\s+[A-Za-z0-9._-]+/i, 'bearer token'],
    [/\bsk-[A-Za-z0-9_-]{8,}/, 'secret-like key'],
    [/data:image\//i, 'inline image data URL'],
    [/api[_-]?key["']?\s*[:=]\s*["'][^"']+/i, 'inline API key assignment']
  ];
  for (const [pattern, description] of patterns) {
    if (pattern.test(serialized)) {
      fail(`${label}: contains forbidden ${description}`);
    }
  }
}

function assertOpenRouterModel(capabilities, modelKey, expectedModelId) {
  const model = capabilities.openrouter.models[modelKey];
  check(model !== undefined, `openrouter.models.${modelKey}: missing`);
  if (model === undefined) return;

  equal(model.requestedModelId, expectedModelId, `openrouter.models.${modelKey}.requestedModelId`);
  check(
    typeof model.observedDatedModelId === 'string' &&
      model.observedDatedModelId === `${expectedModelId}-20260908`,
    `openrouter.models.${modelKey}.observedDatedModelId`
  );
  equal(model.provider.providerName, 'OpenAI', `openrouter.models.${modelKey}.provider.providerName`);
  equal(model.provider.providerSlug, 'openai', `openrouter.models.${modelKey}.provider.providerSlug`);
  equal(model.provider.providerTag, 'openai', `openrouter.models.${modelKey}.provider.providerTag`);

  includes(model.supportedParameters.aspect_ratio?.values, '1:1', `${modelKey}.aspect_ratio`);
  includes(model.supportedParameters.quality?.values, 'medium', `${modelKey}.quality`);
  includes(model.supportedParameters.background?.values, 'opaque', `${modelKey}.background`);
  equal(model.supportedParameters.n?.min, 1, `${modelKey}.n.min`);
  equal(model.supportedParameters.n?.max, 10, `${modelKey}.n.max`);
  equal(model.supportedParameters.input_references?.min, 0, `${modelKey}.input_references.min`);
  equal(model.supportedParameters.input_references?.max, 16, `${modelKey}.input_references.max`);
  equal(model.supportedParameters.output_compression?.min, 0, `${modelKey}.output_compression.min`);
  equal(model.supportedParameters.output_compression?.max, 100, `${modelKey}.output_compression.max`);

  for (const unsupported of ['mask', 'size', 'resolution', 'output_format', 'seed']) {
    check(
      !Object.prototype.hasOwnProperty.call(model.supportedParameters, unsupported),
      `${modelKey}: ${unsupported} must not be advertised as supported`
    );
  }

  equal(model.supportsStreaming, true, `${modelKey}.supportsStreaming`);
  includes(model.allowedPassthroughParameters, 'moderation', `${modelKey}.allowedPassthroughParameters`);

  const rates = new Map((model.pricing ?? []).map((rate) => [rate.billable, rate]));
  closeTo(rates.get('input_text')?.cost_usd, 0.000005, `${modelKey}.pricing.input_text`);
  closeTo(rates.get('input_image')?.cost_usd, 0.000008, `${modelKey}.pricing.input_image`);
  closeTo(rates.get('output_image')?.cost_usd, 0.00003, `${modelKey}.pricing.output_image`);
}

const capabilities = readJson('src/config/provider-capabilities.json');
const pricing = readJson('src/config/pricing.json');

if (capabilities !== undefined && pricing !== undefined) {
  equal(capabilities.schemaVersion, 1, 'provider-capabilities.schemaVersion');
  equal(pricing.schemaVersion, 1, 'pricing.schemaVersion');
  equal(capabilities.evidenceKind, 'public-documentation', 'provider-capabilities.evidenceKind');
  equal(pricing.evidenceKind, 'public-documentation', 'pricing.evidenceKind');
  check(
    /^\d{4}-\d{2}-\d{2}-v[1-9]\d*$/.test(pricing.version),
    'pricing.version: expected YYYY-MM-DD-vN'
  );
  equal(pricing.capabilityVersion, capabilities.version, 'pricing.capabilityVersion');
  equal(pricing.checkedAt, capabilities.checkedAt, 'pricing.checkedAt');
  equal(pricing.currency, 'USD', 'pricing.currency');

  const expectedFreeze = {
    nativeMaskParameter: false,
    exactSizeParameter: false,
    outputFormatParameter: false,
    promptRewriter: false,
    providerFallback: false,
    additionalImageModels: false,
    additionalImageProviders: false,
    streamingImageResponse: false,
    automaticRetries: false
  };
  for (const [key, expected] of Object.entries(expectedFreeze)) {
    equal(capabilities.contractFreeze?.[key], expected, `contractFreeze.${key}`);
  }

  equal(
    capabilities.openrouter.api.imagesEndpoint,
    'https://openrouter.ai/api/v1/images',
    'openrouter.api.imagesEndpoint'
  );
  equal(capabilities.openrouter.auth.envVar, 'OPENROUTER_API_KEY', 'openrouter.auth.envVar');
  equal(capabilities.openrouter.auth.scheme, 'Bearer', 'openrouter.auth.scheme');
  equal(capabilities.openrouter.auth.serverSideOnly, true, 'openrouter.auth.serverSideOnly');

  assertOpenRouterModel(capabilities, 'flare', 'openai/gpt-image-2.5-flare');
  assertOpenRouterModel(capabilities, 'sunburst', 'openai/gpt-image-2.5-sunburst');

  const fixedRequest = capabilities.openrouter.fixedRequest;
  equal(fixedRequest.modelSelection.generation, 'flare', 'fixedRequest.modelSelection.generation');
  includes(fixedRequest.modelSelection.edit, 'flare', 'fixedRequest.modelSelection.edit');
  includes(fixedRequest.modelSelection.edit, 'sunburst', 'fixedRequest.modelSelection.edit');
  includes(fixedRequest.modelSelection.comparison, 'flare', 'fixedRequest.modelSelection.comparison');
  includes(fixedRequest.modelSelection.comparison, 'sunburst', 'fixedRequest.modelSelection.comparison');
  equal(fixedRequest.common.aspect_ratio, '1:1', 'fixedRequest.common.aspect_ratio');
  equal(fixedRequest.common.quality, 'medium', 'fixedRequest.common.quality');
  equal(fixedRequest.common.background, 'opaque', 'fixedRequest.common.background');
  equal(fixedRequest.common.n, 1, 'fixedRequest.common.n');
  equal(fixedRequest.common.provider.only.length, 1, 'fixedRequest.common.provider.only');
  equal(fixedRequest.common.provider.only[0], 'openai', 'fixedRequest.common.provider.only[0]');
  equal(fixedRequest.common.provider.allow_fallbacks, false, 'fixedRequest.common.provider.allow_fallbacks');
  equal(fixedRequest.generation.inputReferences, 'omit', 'fixedRequest.generation.inputReferences');
  equal(fixedRequest.generation.orderedInputImages, 0, 'fixedRequest.generation.orderedInputImages');
  equal(
    fixedRequest.edit.inputReferences,
    'source-first-then-user-references',
    'fixedRequest.edit.inputReferences'
  );
  equal(fixedRequest.edit.userReferenceCount.min, 0, 'fixedRequest.edit.userReferenceCount.min');
  equal(fixedRequest.edit.userReferenceCount.max, 2, 'fixedRequest.edit.userReferenceCount.max');
  equal(fixedRequest.edit.totalInputImages.min, 1, 'fixedRequest.edit.totalInputImages.min');
  equal(fixedRequest.edit.totalInputImages.max, 3, 'fixedRequest.edit.totalInputImages.max');
  equal(fixedRequest.edit.sourceImageIndex, 1, 'fixedRequest.edit.sourceImageIndex');
  equal(
    fixedRequest.edit.userReferenceImageIndices.join(','),
    '2,3',
    'fixedRequest.edit.userReferenceImageIndices'
  );
  equal(fixedRequest.edit.omitAbsentReferences, true, 'fixedRequest.edit.omitAbsentReferences');
  for (const forbiddenImage of ['selection-mask', 'allowed-mask', 'blend-mask', 'highlighted-scene']) {
    includes(
      fixedRequest.edit.forbiddenAdditionalInputImages,
      forbiddenImage,
      'fixedRequest.edit.forbiddenAdditionalInputImages'
    );
  }

  for (const forbidden of ['mask', 'size', 'resolution', 'output_format', 'seed', 'stream']) {
    includes(capabilities.openrouter.forbiddenRequestFields, forbidden, 'openrouter.forbiddenRequestFields');
  }
  includes(
    capabilities.openrouter.supportedButUnusedRequestFields,
    'output_compression',
    'openrouter.supportedButUnusedRequestFields'
  );

  const responseContract = capabilities.openrouter.responseContract;
  equal(responseContract.buffered, true, 'responseContract.buffered');
  equal(responseContract.streaming, false, 'responseContract.streaming');
  equal(responseContract.timeoutMs, 300000, 'responseContract.timeoutMs');
  equal(responseContract.automaticRetries, false, 'responseContract.automaticRetries');
  equal(responseContract.exactlyOneImage, true, 'responseContract.exactlyOneImage');
  equal(responseContract.requiredImageField, 'b64_json', 'responseContract.requiredImageField');
  equal(responseContract.optionalMediaTypeField, 'media_type', 'responseContract.optionalMediaTypeField');
  equal(
    responseContract.allowedMediaTypes.join(','),
    'image/png,image/jpeg,image/webp',
    'responseContract.allowedMediaTypes'
  );
  equal(responseContract.singleFrame, true, 'responseContract.singleFrame');
  equal(responseContract.maxDecodedImageBytes, 31457280, 'responseContract.maxDecodedImageBytes');
  equal(responseContract.squareSidePixels.min, 512, 'responseContract.squareSidePixels.min');
  equal(responseContract.squareSidePixels.max, 4096, 'responseContract.squareSidePixels.max');
  equal(responseContract.errorBodySanitization, 'required', 'responseContract.errorBodySanitization');

  const reservations = pricing.reservations;
  equal(reservations.projectBudget.usd, 5, 'reservations.projectBudget.usd');
  equal(reservations.projectBudget.usdMicros, 5000000, 'reservations.projectBudget.usdMicros');
  equal(reservations.image.usd, 0.25, 'reservations.image.usd');
  equal(reservations.image.usdMicros, 250000, 'reservations.image.usdMicros');
  equal(reservations.comparison.usd, 0.5, 'reservations.comparison.usd');
  equal(reservations.comparison.usdMicros, 500000, 'reservations.comparison.usdMicros');
  equal(reservations.segmentation.usd, 0.0025, 'reservations.segmentation.usd');
  equal(reservations.segmentation.usdMicros, 2500, 'reservations.segmentation.usdMicros');

  for (const modelId of ['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst']) {
    const modelKey = modelId.endsWith('flare') ? 'flare' : 'sunburst';
    const capabilityRates = new Map(
      capabilities.openrouter.models[modelKey].pricing.map((rate) => [rate.billable, rate])
    );
    const pricingModel = pricing.providers.openrouter.models[modelId];
    check(pricingModel !== undefined, `pricing.providers.openrouter.models.${modelId}: missing`);
    if (pricingModel === undefined) continue;
    for (const [billable, capabilityRate] of capabilityRates.entries()) {
      const pricingRate = pricingModel.rates.find((rate) => rate.billable === billable);
      check(pricingRate !== undefined, `pricing rate missing for ${modelId}/${billable}`);
      if (pricingRate === undefined) continue;
      closeTo(pricingRate.usdPerToken, capabilityRate.cost_usd, `${modelId}/${billable}.usdPerToken`);
      closeTo(
        pricingRate.usdPerMillionTokens,
        capabilityRate.cost_usd * 1_000_000,
        `${modelId}/${billable}.usdPerMillionTokens`
      );
    }
  }

  const sam = capabilities.metaSam;
  equal(sam.api.baseUrl, 'https://api.meta.ai/v1', 'metaSam.api.baseUrl');
  equal(sam.api.responsesEndpoint, 'https://api.meta.ai/v1/responses', 'metaSam.api.responsesEndpoint');
  equal(sam.auth.envVar, 'META_MODEL_API_KEY', 'metaSam.auth.envVar');
  equal(sam.auth.scheme, 'Bearer', 'metaSam.auth.scheme');
  equal(sam.auth.serverSideOnly, true, 'metaSam.auth.serverSideOnly');
  equal(sam.model, 'sam-3.1', 'metaSam.model');
  equal(sam.transport.sdk, 'openai', 'metaSam.transport.sdk');
  equal(sam.transport.baseUrl, 'https://api.meta.ai/v1', 'metaSam.transport.baseUrl');
  equal(sam.transport.timeoutMs, 120000, 'metaSam.transport.timeoutMs');
  equal(sam.transport.maxRetries, 0, 'metaSam.transport.maxRetries');
  equal(sam.transport.stream, true, 'metaSam.transport.stream');
  equal(sam.transport.nonStreamingUsed, false, 'metaSam.transport.nonStreamingUsed');
  equal(sam.parser.package, '@meta-sam/parser', 'metaSam.parser.package');
  equal(sam.parser.requiredVersion, '>=0.1.0', 'metaSam.parser.requiredVersion');
  equal(sam.parser.verifiedVersion, '0.1.0', 'metaSam.parser.verifiedVersion');
  equal(sam.parser.importFromPackageRootOnly, true, 'metaSam.parser.importFromPackageRootOnly');
  for (const exportName of ['buildObjectPrompt', 'parseImageStream', 'decodeMaskToRaster', 'recordsOfKind']) {
    includes(sam.parser.requiredExports, exportName, 'metaSam.parser.requiredExports');
  }
  equal(sam.prompt.builder, 'buildObjectPrompt', 'metaSam.prompt.builder');
  equal(sam.prompt.size.width, 1024, 'metaSam.prompt.size.width');
  equal(sam.prompt.size.height, 1024, 'metaSam.prompt.size.height');
  equal(sam.prompt.objectId, '1', 'metaSam.prompt.objectId');
  equal(sam.prompt.positivePoints, 1, 'metaSam.prompt.positivePoints');
  equal(sam.prompt.negativePoints.min, 0, 'metaSam.prompt.negativePoints.min');
  equal(sam.prompt.negativePoints.max, 1, 'metaSam.prompt.negativePoints.max');
  equal(sam.prompt.metadata.mask_encoding, 'one_bit', 'metaSam.prompt.metadata.mask_encoding');
  equal(sam.outputContract.requiresCompletedOutcome, true, 'metaSam.outputContract.requiresCompletedOutcome');
  equal(sam.outputContract.errorDiagnosticsAllowed, 0, 'metaSam.outputContract.errorDiagnosticsAllowed');
  equal(sam.outputContract.maskEncodingObserved, 'one_bit', 'metaSam.outputContract.maskEncodingObserved');
  equal(sam.outputContract.boxBounds, 'half-open', 'metaSam.outputContract.boxBounds');
  equal(
    sam.outputContract.maskDimensionsOrderOnWire,
    'height,width',
    'metaSam.outputContract.maskDimensionsOrderOnWire'
  );
  equal(sam.outputContract.maskRasterCroppedToBounds, true, 'metaSam.outputContract.maskRasterCroppedToBounds');
  equal(sam.outputContract.pasteOrigin, 'parsed-box-left-top', 'metaSam.outputContract.pasteOrigin');
  equal(sam.outputContract.resizeCroppedMask, false, 'metaSam.outputContract.resizeCroppedMask');
  equal(sam.outputContract.boundsMustMatchBox, true, 'metaSam.outputContract.boundsMustMatchBox');
  equal(sam.outputContract.validateMaskDimensions, true, 'metaSam.outputContract.validateMaskDimensions');
  equal(sam.outputContract.validateRasterLength, true, 'metaSam.outputContract.validateRasterLength');
  equal(sam.outputContract.streamConsumedOnce, true, 'metaSam.outputContract.streamConsumedOnce');
  equal(sam.outputContract.preserveTerminalMetadata, true, 'metaSam.outputContract.preserveTerminalMetadata');
  for (const rejection of [
    'out-of-bounds-box',
    'missing-or-duplicate-object-records',
    'inconsistent-crop-dimensions',
    'non-binary-pixels',
    'empty-mask',
    'incomplete-stream',
    'error-diagnostics'
  ]) {
    includes(sam.outputContract.rejections, rejection, 'metaSam.outputContract.rejections');
  }
  equal(
    sam.outputContract.selectionValidation.positivePixelValue,
    1,
    'metaSam.outputContract.selectionValidation.positivePixelValue'
  );
  equal(
    sam.outputContract.selectionValidation.negativePixelValue,
    0,
    'metaSam.outputContract.selectionValidation.negativePixelValue'
  );
  equal(
    sam.outputContract.selectionValidation.failureCode,
    'INVALID_SELECTION',
    'metaSam.outputContract.selectionValidation.failureCode'
  );
  equal(sam.outputContract.fullFrameMask.width, 1024, 'metaSam.outputContract.fullFrameMask.width');
  equal(sam.outputContract.fullFrameMask.height, 1024, 'metaSam.outputContract.fullFrameMask.height');
  equal(
    sam.outputContract.fullFrameMask.values.join(','),
    '0,255',
    'metaSam.outputContract.fullFrameMask.values'
  );

  const metaRates = pricing.providers.meta.rates;
  const imageRate = metaRates.find((rate) => rate.billable === 'input_image');
  check(imageRate !== undefined, 'pricing.providers.meta.rates.input_image: missing');
  if (imageRate !== undefined) {
    closeTo(imageRate.usdPerImage, 0.0025, 'meta.rates.input_image.usdPerImage');
    closeTo(imageRate.usdPer1000Images, 2.5, 'meta.rates.input_image.usdPer1000Images');
  }

  for (const provider of ['openrouter', 'meta']) {
    const access = capabilities.accountAccess[provider];
    equal(access.status, 'not_verified', `accountAccess.${provider}.status`);
    equal(access.evidence, 'public-documentation-only', `accountAccess.${provider}.evidence`);
    equal(access.paidProbePerformed, false, `accountAccess.${provider}.paidProbePerformed`);
    equal(access.separateAccount, true, `accountAccess.${provider}.separateAccount`);
  }

  equal(capabilities.gate.status, 'pass', 'gate.status');
  check(Array.isArray(capabilities.gate.blockers), 'gate.blockers: expected an array');
  equal(capabilities.gate.blockers.length, 0, 'gate.blockers.length');
  check(Array.isArray(capabilities.sources), 'sources: expected an array');
  check(capabilities.sources.length >= 10, 'sources: expected at least 10 documented sources');
  for (const source of capabilities.sources ?? []) {
    check(typeof source.url === 'string' && source.url.startsWith('https://'), 'source.url must be HTTPS');
    equal(source.checkedAt, '2026-10-21', `source.checkedAt for ${source.url}`);
  }
}

const fixturesDirectory = join(root, 'src/test/fixtures/providers');
const manifest = readJson('src/test/fixtures/providers/manifest.json');
const fixtureFilesOnDisk = walkJsonFiles(fixturesDirectory)
  .filter((absolutePath) => absolutePath !== join(fixturesDirectory, 'manifest.json'))
  .map((absolutePath) => relative(fixturesDirectory, absolutePath).replaceAll('\\', '/'))
  .sort();

if (manifest !== undefined) {
  equal(manifest.schemaVersion, 1, 'fixtures.manifest.schemaVersion');
  equal(manifest.checkedAt, '2026-10-21', 'fixtures.manifest.checkedAt');
  check(Array.isArray(manifest.fixtures), 'fixtures.manifest.fixtures: expected an array');
  check(
    Array.isArray(manifest.capturedLiveFixtures) && manifest.capturedLiveFixtures.length === 0,
    'fixtures.manifest.capturedLiveFixtures must be empty in Phase 0'
  );

  const manifestPaths = new Set();
  for (const entry of manifest.fixtures ?? []) {
    check(typeof entry.path === 'string', `fixtures.manifest entry ${entry.id}: missing path`);
    if (typeof entry.path !== 'string') continue;
    manifestPaths.add(entry.path);
    const fixture = readJson(`src/test/fixtures/providers/${entry.path}`);
    if (fixture === undefined) continue;

    equal(fixture.fixtureKind, entry.fixtureKind, `${entry.path}.fixtureKind`);
    equal(fixture.fixtureKind, 'documented-example', `${entry.path}.fixtureKind must be documented-example`);
    equal(fixture.retrievedAt, '2026-10-21', `${entry.path}.retrievedAt`);
    check(
      typeof fixture.sourceUrl === 'string' && fixture.sourceUrl.startsWith('https://'),
      `${entry.path}.sourceUrl must be HTTPS`
    );
    check(typeof fixture.shapeOnly === 'boolean', `${entry.path}.shapeOnly: expected a boolean`);
    assertNoSensitiveFixtureContent(fixture, entry.path);

    if (entry.provider === 'openrouter') {
      equal(fixture.shapeOnly, true, `${entry.path}.shapeOnly must be true for documented OpenRouter examples`);
      check(fixture.response !== undefined, `${entry.path}.response: missing`);
      if (fixture.response !== undefined) {
        if (entry.operation === 'image-generation') {
          check(Array.isArray(fixture.response.data), `${entry.path}.response.data: expected an array`);
          equal(fixture.response.data?.length, 1, `${entry.path}.response.data.length`);
          check(
            typeof fixture.response.data?.[0]?.b64_json === 'string',
            `${entry.path}.response.data[0].b64_json: expected a string`
          );
          equal(
            fixture.response.data?.[0]?.b64_json,
            '<redacted-base64-image-bytes>',
            `${entry.path}.response.data[0].b64_json must stay redacted`
          );
          equal(
            fixture.response.data?.[0]?.media_type,
            'image/png',
            `${entry.path}.response.data[0].media_type`
          );
          check(
            typeof fixture.response.created === 'number',
            `${entry.path}.response.created: expected a number`
          );
          closeTo(fixture.response.usage?.cost, 0.04, `${entry.path}.response.usage.cost`);
        } else if (entry.operation === 'image-generation-error') {
          equal(fixture.httpStatus, 402, `${entry.path}.httpStatus`);
          equal(fixture.response.error?.code, 402, `${entry.path}.response.error.code`);
          check(
            typeof fixture.response.error?.message === 'string',
            `${entry.path}.response.error.message: expected a string`
          );
        } else {
          fail(`${entry.path}: unexpected OpenRouter operation ${entry.operation}`);
        }
      }
    } else if (entry.provider === 'meta') {
      check(typeof fixture.outputText === 'string', `${entry.path}.outputText: expected a string`);
      equal(fixture.expected?.outcome, 'completed', `${entry.path}.expected.outcome`);
      check(
        Array.isArray(fixture.expected?.diagnostics) && fixture.expected.diagnostics.length === 0,
        `${entry.path}.expected.diagnostics must be empty`
      );
      check(
        Array.isArray(fixture.expected?.objects) && fixture.expected.objects.length > 0,
        `${entry.path}.expected.objects: expected at least one documented object`
      );
      check(fixture.outputText.startsWith('<0f>'), `${entry.path}.outputText must start with a frame marker`);

      const records = [];
      const recordPattern =
        /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|><\|mask;x=0;y=0;data=(\d+),(\d+),([~!])([^|]+)\|>/g;
      for (const match of fixture.outputText.matchAll(recordPattern)) {
        records.push({
          objectId: match[1],
          x1: Number(match[2]),
          y1: Number(match[3]),
          x2: Number(match[4]),
          y2: Number(match[5]),
          frameWidth: Number(match[6]),
          frameHeight: Number(match[7]),
          maskHeight: Number(match[8]),
          maskWidth: Number(match[9]),
          encodingMarker: match[10],
          payload: match[11]
        });
      }
      equal(records.length, fixture.expected?.objects?.length, `${entry.path}: parsed documented records`);
      equal(records[0]?.frameWidth, fixture.sourceMedia?.width, `${entry.path}: source width`);
      equal(records[0]?.frameHeight, fixture.sourceMedia?.height, `${entry.path}: source height`);
      for (const record of records) {
        equal(record.frameWidth, fixture.sourceMedia?.width, `${entry.path}: record source width`);
        equal(record.frameHeight, fixture.sourceMedia?.height, `${entry.path}: record source height`);
        check(
          record.x1 >= 0 &&
            record.y1 >= 0 &&
            record.x2 + 1 <= fixture.sourceMedia?.width &&
            record.y2 + 1 <= fixture.sourceMedia?.height,
          `${entry.path}/${record.objectId}: box lies outside the source frame`
        );
      }

      const encodingByMarker = {
        '~': 'lossless',
        '!': 'one_bit'
      };

      for (const expectedObject of fixture.expected?.objects ?? []) {
        const record = records.find((candidate) => candidate.objectId === expectedObject.objectId);
        check(record !== undefined, `${entry.path}: missing object ${expectedObject.objectId}`);
        if (record === undefined) continue;
        equal(record.x1, expectedObject.box.left, `${entry.path}/${record.objectId}: box.left`);
        equal(record.y1, expectedObject.box.top, `${entry.path}/${record.objectId}: box.top`);
        equal(record.x2 + 1, expectedObject.box.right, `${entry.path}/${record.objectId}: half-open right`);
        equal(record.y2 + 1, expectedObject.box.bottom, `${entry.path}/${record.objectId}: half-open bottom`);
        equal(
          record.maskWidth,
          expectedObject.box.right - expectedObject.box.left,
          `${entry.path}/${record.objectId}: mask width`
        );
        equal(
          record.maskHeight,
          expectedObject.box.bottom - expectedObject.box.top,
          `${entry.path}/${record.objectId}: mask height`
        );
        equal(record.maskWidth, expectedObject.mask.width, `${entry.path}/${record.objectId}: mask.width`);
        equal(record.maskHeight, expectedObject.mask.height, `${entry.path}/${record.objectId}: mask.height`);
        equal(
          record.maskWidth * record.maskHeight,
          expectedObject.rasterLength,
          `${entry.path}/${record.objectId}: raster length`
        );
        check(
          encodingByMarker[record.encodingMarker] !== undefined,
          `${entry.path}/${record.objectId}: unknown mask encoding marker`
        );
        equal(
          encodingByMarker[record.encodingMarker],
          expectedObject.mask.encoding,
          `${entry.path}/${record.objectId}: mask encoding`
        );
        check(record.payload.length > 0, `${entry.path}/${record.objectId}: empty mask payload`);
      }
    } else {
      fail(`${entry.path}: unexpected provider ${entry.provider}`);
    }
  }

  for (const pathOnDisk of fixtureFilesOnDisk) {
    check(manifestPaths.has(pathOnDisk), `fixture ${pathOnDisk} is not listed in manifest.json`);
  }
  for (const manifestPath of manifestPaths) {
    check(fixtureFilesOnDisk.includes(manifestPath), `manifest fixture ${manifestPath} is missing on disk`);
  }
}

if (failures.length > 0) {
  console.error('Provider contract check FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Provider contract check passed.');
console.log(`- Capability version: ${capabilities?.version ?? 'unknown'}`);
console.log(`- Pricing version: ${pricing?.version ?? 'unknown'}`);
console.log(`- Documented fixtures: ${manifest?.fixtures?.length ?? 0}`);
console.log('- Captured-live fixtures: 0');
console.log('- No network calls, credentials or paid probes were used.');
