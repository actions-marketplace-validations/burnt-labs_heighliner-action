import * as core from "@actions/core";
import * as exec from "@actions/exec";
import YAML from "yaml";
import fs from "fs/promises";
import path from "path";

export async function heighliner(
  args?: string[],
  opts?: exec.ExecOptions
): Promise<exec.ExecOutput> {
  return exec.getExecOutput("heighliner", args, opts);
}

const buildKeysString = [
  "chain",
  "chains-spec-file",
  "tag",
  "org",
  "registry",
  "platform",
] as const;

const buildKeysBoolean = ["local", "buildkit"] as const;

type BuildOptionsString = {
  [K in (typeof buildKeysString)[number]]?: string;
};

type BuildOptionsBoolean = {
  [K in (typeof buildKeysBoolean)[number]]?: boolean;
};

type BuildOptions = BuildOptionsString & BuildOptionsBoolean;

export function getBuildOptions(): BuildOptions {
  const stringOptions = buildKeysString.reduce((opts, key) => {
    const input = core.getInput(key);
    if (input !== "") {
      opts[key] = core.getInput(key);
    }
    return opts;
  }, {} as BuildOptionsString);
  const booleanOptions = buildKeysBoolean.reduce((opts, key) => {
    opts[key] = core.getBooleanInput(key);
    return opts;
  }, {} as BuildOptionsBoolean);

  return {
    ...stringOptions,
    ...booleanOptions,
  };
}

const chainSpecKeys = [
  "repo-host",
  "github-organization",
  "github-repo",
  "dockerfile",
  "build-env",
  "pre-build",
  "build-target",
  "binaries",
  "libraries",
] as const;

type ChainSpecInput = {
  [K in (typeof chainSpecKeys)[number]]?: string;
};

type ChainSpec = ChainSpecInput & { name: string };

function buildOptionsToArguments(opts: BuildOptions): string[] {
  let args = ["build"];

  if (opts.chain !== undefined) {
    args = [...args, "--chain", opts.chain];
  }

  if (opts["chains-spec-file"] !== undefined) {
    args = [...args, "--file", opts["chains-spec-file"]];
  }

  if (opts.local) {
    args = [...args, "--local"];
  }

  if (opts.org !== undefined) {
    args = [...args, "--org", opts.org];
  }

  if (opts.registry !== undefined) {
    args = [...args, "--registry", opts.registry];
  }

  if (opts.tag !== undefined) {
    args = [...args, "--tag", opts.tag];
  }

  if (opts.buildkit) {
    args = [...args, "--use-buildkit"];
  }

  if (opts.platform !== undefined) {
    args = [...args, "--platform", opts.platform];
  }

  return args;
}

export function getChainSpecInputs(): ChainSpec | undefined {
  const spec = chainSpecKeys.reduce((spec, key) => {
    const value = core.getInput(key);
    if (value !== "") {
      spec[key] = value;
    }
    return spec;
  }, {} as ChainSpec);

  if (Object.keys(spec).length > 0) {
    // We alias chain to name
    spec.name = core.getInput("chain");
    return spec;
  }

  return;
}

interface ImageMetadata {
  Id: string;
  RepoDigests: string[];
}

async function getImageMetadata(
  imageId: string
): Promise<[ImageMetadata, string]> {
  const inspectOutput = await exec.getExecOutput("docker", [
    "inspect",
    imageId,
  ]);
  const inspectJSON = inspectOutput.stdout;
  const metadata = JSON.parse(inspectJSON) as ImageMetadata[];

  if (metadata.length < 1) {
    throw new Error(
      "Expected docker metadata to include at least one result, got none."
    );
  }

  return [metadata[0], inspectJSON];
}

interface BuildOutput {
  imageid: string;
  digest?: string;
  metadata: string;
  tag: string;
}

export async function buildImage(
  opts: BuildOptions,
  spec?: ChainSpec
): Promise<BuildOutput> {
  // If a custom chain config is provided, override chains.yaml
  if (spec !== undefined) {
    const specYAML = YAML.stringify([spec]);
    const mktempOutput = await exec.getExecOutput("mktemp", ["-d"]);
    const dir = mktempOutput.stdout.trim();
    const filepath = path.join(dir, "chains.yaml");
    await fs.writeFile(filepath, specYAML);
    opts["chains-spec-file"] = filepath;
  }

  const args = buildOptionsToArguments(opts);
  const buildOutput = await heighliner(args);
  const outputLines = buildOutput.stdout.split("\n");
  const matches = outputLines.flatMap((line) => {
    const match = line.match(/Successfully (tagged|built) (\S+)/);
    if (match === null) {
      return [];
    }
    return [match];
  });
  const imageIdMatch = matches.find((match) => match[1] === "built");
  if (imageIdMatch === undefined) {
    const err = new Error("Couldn't find imageid");
    core.setFailed(err);
    throw err;
  }
  const shortId = imageIdMatch[2];
  const tagMatch = matches.find((match) => match[1] === "tagged");
  if (tagMatch === undefined) {
    const err = new Error("Couldn't find tag");
    core.setFailed(err);
    throw err;
  }
  const tag = tagMatch[2];

  const [parsedMetadata, metadata] = await getImageMetadata(shortId);

  return {
    imageid: parsedMetadata.Id,
    digest: parsedMetadata.RepoDigests[0],
    metadata,
    tag,
  };
}
