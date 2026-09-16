import { readFile } from "node:fs/promises";
import ts from "typescript";

const configUrl = new URL("../wrangler.e3-dev.jsonc", import.meta.url);
const configText = await readFile(configUrl, "utf8");
const parsed = ts.parseConfigFileTextToJson(configUrl.pathname, configText);
if (parsed.error) throw new Error("E-3.2のWrangler設定を読み込めません");
const config = parsed.config;
const r2Binding = config.r2_buckets?.find((binding) => binding.binding === "VIDEO_UPLOADS_R2");
const signedBucketName = config.vars?.R2_BUCKET_NAME;

if (!r2Binding?.bucket_name || !signedBucketName) {
  throw new Error("E-3.2のR2 bindingまたは署名用bucket名が設定されていません");
}
if (r2Binding.bucket_name !== signedBucketName) {
  throw new Error("E-3.2のR2 bindingと署名URLのbucket名が一致しません");
}

console.log("E-3.2 R2設定: bindingと署名用bucket名の一致を確認しました");
