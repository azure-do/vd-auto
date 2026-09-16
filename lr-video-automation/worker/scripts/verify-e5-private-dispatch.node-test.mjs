import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_DIRECTORY = new URL("../src/", import.meta.url);
const BOUNDARY_FILE = "e5-youtube-private-request.ts";

async function sourceFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(new URL(`${entry.name}/`, directory), `${relative}/`));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push({ relative, url: new URL(entry.name, directory) });
    }
  }
  return files;
}

async function analyzeSourceDirectory(directory) {
  const legacyRawAccesses = new Set();
  const capabilityReferencesOutsideBoundary = new Set();
  const guardedDispatchCalls = [];
  const capabilityNames = new Set([
    "PrivateYouTubeAdapter",
    "guardedClientAdapters",
    "registerPrivateYouTubeAdapter",
  ]);

  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file.url, "utf8");
    const ast = ts.createSourceFile(file.relative, source, ts.ScriptTarget.Latest, true);
    const stringInitializers = new Map();
    const dispatchNames = new Set(["dispatchGuardedPrivateYouTubeUpload"]);
    const localCapabilityNames = new Set(capabilityNames);

    const collectBindings = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) stringInitializers.set(node.name.text, node.initializer);
      if (ts.isImportSpecifier(node)) {
        const importedName = (node.propertyName ?? node.name).text;
        if (importedName === "dispatchGuardedPrivateYouTubeUpload") {
          dispatchNames.add(node.name.text);
        }
        if (capabilityNames.has(importedName)) localCapabilityNames.add(node.name.text);
      }
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(ast);

    const constantString = (node, seen = new Set()) => {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const left = constantString(node.left, seen);
        const right = constantString(node.right, seen);
        return left === undefined || right === undefined ? undefined : left + right;
      }
      if (ts.isIdentifier(node) && !seen.has(node.text)) {
        const initializer = stringInitializers.get(node.text);
        if (!initializer) return undefined;
        const nextSeen = new Set(seen);
        nextSeen.add(node.text);
        return constantString(initializer, nextSeen);
      }
      return undefined;
    };

    const visit = (node) => {
      if (
        (ts.isPropertyAccessExpression(node) && node.name.text === "startPrivateUpload") ||
        (ts.isElementAccessExpression(node) &&
          constantString(node.argumentExpression) === "startPrivateUpload")
      ) legacyRawAccesses.add(file.relative);
      if (
        ts.isIdentifier(node) &&
        localCapabilityNames.has(node.text) &&
        file.relative !== BOUNDARY_FILE
      ) capabilityReferencesOutsideBoundary.add(file.relative);
      if (ts.isCallExpression(node)) {
        const called = node.expression;
        if (
          (ts.isIdentifier(called) && dispatchNames.has(called.text)) ||
          (ts.isPropertyAccessExpression(called) &&
            called.name.text === "dispatchGuardedPrivateYouTubeUpload") ||
          (ts.isElementAccessExpression(called) &&
            constantString(called.argumentExpression) === "dispatchGuardedPrivateYouTubeUpload")
        ) guardedDispatchCalls.push(file.relative);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return {
    legacyRawAccesses: [...legacyRawAccesses],
    capabilityReferencesOutsideBoundary: [...capabilityReferencesOutsideBoundary],
    guardedDispatchCalls,
  };
}

test("raw YouTube adapter capability stays inside the recursive guarded boundary", async () => {
  const {
    legacyRawAccesses,
    capabilityReferencesOutsideBoundary,
    guardedDispatchCalls,
  } = await analyzeSourceDirectory(SOURCE_DIRECTORY);

  assert.deepEqual(legacyRawAccesses, []);
  assert.deepEqual(capabilityReferencesOutsideBoundary, []);
  assert.deepEqual(guardedDispatchCalls.sort(), [
    BOUNDARY_FILE,
    "e5-service.ts",
  ].sort());
});

test("recursive AST scan detects alias, computed raw method, and private factory bypasses", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "e5-private-architecture-"));
  try {
    const nestedDirectory = join(fixtureRoot, "future", "adapter");
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(
      join(nestedDirectory, "youtube.ts"),
      `import {
  dispatchGuardedPrivateYouTubeUpload as send,
  registerPrivateYouTubeAdapter as unsafeFactory,
} from "../../e5-youtube-private-request";
const prefix = "start";
const rawMethod = prefix + "PrivateUpload";
client[rawMethod](request);
send(client, request);
unsafeFactory(adapter);
`,
      "utf8",
    );

    const result = await analyzeSourceDirectory(pathToFileURL(`${fixtureRoot}/`));
    assert.deepEqual(result.legacyRawAccesses, ["future/adapter/youtube.ts"]);
    assert.deepEqual(result.capabilityReferencesOutsideBoundary, ["future/adapter/youtube.ts"]);
    assert.deepEqual(result.guardedDispatchCalls, ["future/adapter/youtube.ts"]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
