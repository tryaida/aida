// The engine's npm package name. The product and its CLI command are both `aida`, but the name
// `aida` on the npm registry belongs to an unrelated package (decisions #29), so the engine is
// the package `aida-docs`: configs, adapters and the help app import from "aida-docs" and
// "aida-docs/dist/...". Not published yet; the help app depends on a packed tarball of it.
export const AIDA_PACKAGE = "aida-docs";

/** The engine's package name before it was renamed, and the unrelated registry package that
 * owns it. Never resolved: the config loader refuses it and `aida init` drops it. */
export const LEGACY_AIDA_PACKAGE = "aida";
