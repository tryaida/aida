// Amazon S3, via the `aws` CLI (`aws s3 cp`) — https://docs.aws.amazon.com/cli/latest/reference/s3/cp.html.
// Needs a bucket name from config/env and standard AWS credentials; the CLI itself picks those up
// from the environment, so this adapter never reads a secret value, only its name.
import { createCliBlobAdapter } from "./cli-adapter.js";
import type { BlobAdapter, StagedVideo } from "../types.js";

const ENV_VARS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AIDA_S3_BUCKET"];

export function createS3BlobAdapter(env: Record<string, string | undefined> = process.env): BlobAdapter {
  return createCliBlobAdapter(
    {
      name: "s3",
      envVars: ENV_VARS,
      command: (file: StagedVideo, e) => {
        const bucket = e.AIDA_S3_BUCKET ?? "<bucket>";
        return {
          cmd: "aws",
          args: ["s3", "cp", file.absPath, `s3://${bucket}/${file.relPath}`, "--acl", "public-read"],
          description: `upload ${file.relPath} to s3://${bucket}/${file.relPath}`,
        };
      },
      urlFor: (file: StagedVideo, e) => {
        const bucket = e.AIDA_S3_BUCKET ?? "<bucket>";
        const region = e.AWS_REGION ?? "us-east-1";
        return `https://${bucket}.s3.${region}.amazonaws.com/${file.relPath}`;
      },
    },
    env,
  );
}
