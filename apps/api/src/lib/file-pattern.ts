export const FILE_PATTERN_MAX_LENGTH = 256;
export const FILE_PATTERN_MAX_ALTERNATIVES = 16;

export type FilePatternValidation =
  | { ok: true }
  | { ok: false; reason: string };

const ESCAPABLE_LITERAL = new Set(".*+?^${}()|[]\\".split(""));
const FORBIDDEN_CONTROL = /[\u0000-\u001f\u007f]/u;

function invalid(reason: string): FilePatternValidation {
  return { ok: false, reason };
}

function splitAlternatives(source: string): string[] | null {
  const branches: string[] = [];
  let branch = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "\\") {
      if (i + 1 >= source.length) return null;
      branch += char + source[++i];
      continue;
    }
    if (char === "|") {
      branches.push(branch);
      branch = "";
      continue;
    }
    branch += char;
  }
  branches.push(branch);
  return branches;
}

function validateBranch(branch: string): string | null {
  if (!branch) return "empty alternatives are not allowed";
  let previous: "none" | "literal" | "wildcard" | "anchor" = "none";
  let wildcardRepeats = 0;
  let optionalLiterals = 0;

  for (let i = 0; i < branch.length; i++) {
    const char = branch[i]!;
    if (char === "\\") {
      const escaped = branch[++i];
      if (!escaped || !ESCAPABLE_LITERAL.has(escaped)) {
        return "only escaped regex punctuation is allowed";
      }
      previous = "literal";
      continue;
    }

    if (char === "^") {
      if (i !== 0) return "^ is allowed only at the start of an alternative";
      previous = "anchor";
      continue;
    }
    if (char === "$") {
      if (i !== branch.length - 1) {
        return "$ is allowed only at the end of an alternative";
      }
      previous = "anchor";
      continue;
    }

    if (char === ".") {
      if (branch[i + 1] === "*") {
        wildcardRepeats++;
        if (wildcardRepeats > 1) {
          return "at most one .* wildcard is allowed per alternative";
        }
        i++;
      }
      previous = "wildcard";
      continue;
    }

    if (char === "?") {
      if (previous !== "literal") {
        return "? may quantify only one literal character";
      }
      optionalLiterals++;
      if (optionalLiterals > 1) {
        return "at most one optional literal is allowed per alternative";
      }
      previous = "none";
      continue;
    }

    if ("*+()[]{}".includes(char)) {
      return `regex construct ${char} is not allowed`;
    }

    previous = "literal";
  }
  return null;
}

/**
 * Validate the deliberately small filename-pattern language accepted from
 * module configuration. It supports literals, top-level alternatives,
 * anchors, one `.*` per alternative, and one optional literal per alternative.
 * Grouping, character classes, counted/nested quantifiers and backreferences
 * are rejected instead of relying on heuristic ReDoS detection.
 */
export function validateSafeFilePattern(
  source: string,
  flags = "i",
): FilePatternValidation {
  if (!source) return invalid("filePattern cannot be empty");
  if (source.length > FILE_PATTERN_MAX_LENGTH) {
    return invalid(`filePattern cannot exceed ${FILE_PATTERN_MAX_LENGTH} characters`);
  }
  if (FORBIDDEN_CONTROL.test(source)) {
    return invalid("filePattern cannot contain control characters");
  }
  if (!/^(?:|i|u|iu|ui)$/.test(flags)) {
    return invalid("patternFlags may contain only one i and one u flag");
  }

  const alternatives = splitAlternatives(source);
  if (!alternatives) return invalid("filePattern cannot end with an escape");
  if (alternatives.length > FILE_PATTERN_MAX_ALTERNATIVES) {
    return invalid(
      `filePattern cannot exceed ${FILE_PATTERN_MAX_ALTERNATIVES} alternatives`,
    );
  }
  for (const branch of alternatives) {
    const reason = validateBranch(branch);
    if (reason) return invalid(reason);
  }

  try {
    new RegExp(source, flags);
  } catch {
    return invalid("filePattern is not a valid regular expression");
  }
  return { ok: true };
}

export function compileSafeFilePattern(source: string, flags = "i"): RegExp {
  const validation = validateSafeFilePattern(source, flags);
  if (!validation.ok) {
    throw new Error(`unsafe filePattern: ${validation.reason}`);
  }
  return new RegExp(source, flags);
}
