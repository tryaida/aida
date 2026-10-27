export { createDryRunBlobAdapter } from "./dry-run.js";
export { createVercelBlobAdapter } from "./vercel-blob.js";
export { createS3BlobAdapter } from "./s3.js";
export { createNetlifyBlobsAdapter } from "./netlify-blobs.js";
export { createR2BlobAdapter } from "./r2.js";
export { createSupabaseStorageAdapter } from "./supabase-storage.js";
export { getBlobAdapter, defaultBlobProviderFor, listBlobProviders } from "./registry.js";
