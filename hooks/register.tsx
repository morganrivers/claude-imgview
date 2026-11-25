import { atom, read, update } from "claude-code";
import type {
  Elements,
  EngineInterface,
  Register,
  RenderElement,
  RenderInput,
} from "claude-code";

import type { Shown } from "../types";
import {
  PASTE_KEY,
  baseName,
  decodeBmp,
  expandHome,
  findImagePaths,
  fit,
  fromBase64,
  hasImageSuffix,
  isBitmapFormat,
  isInside,
  parseArgs,
  parseIdentifySize,
  parseOdBytes,
  pasteKey,
  parseSipsSize,
  pastedImageNumbers,
  shortenPath,
  sniffFormat,
  tempDir,
  toCells,
} from "./picture";
import type { Measured, Mode, Size } from "./picture";

const PANE = "imgview";
const KEY = "picture";
// An Image is at most 255 cells a side; a Raster is held to the same here.
const MAX_CELLS = 255;
const USAGE = "Usage: /img [--cells|--pixels] <image path>";
const TEMP_PREFIX = "claude-imgview-";
// A reply draws a chip for its first few image files; each chip's hover card
// holds a picture of at most this many cells.
const MAX_CHIPS = 4;
// The chip of a file outside the working directory says where the file is,
// in this many characters at most.
const OUTSIDE_LABEL_MAX = 40;
// The one thing of the mod the model reads: that a path it writes out is one
// the person can open. Without it a model that made a picture has no reason
// to say where.
const HINT = {
  id: "imgview:paths",
  text:
    "The imgview plugin is installed. The path of an image file written in " +
    "your reply (png, jpg, jpeg, gif, webp, heic, bmp, tif, tiff) becomes a " +
    "chip under the reply that the person hovers or clicks to preview the " +
    "picture, and `/img <path>` opens one too. So when you create, change or " +
    "refer to an image file, write its full path in the reply, bare or in a " +
    "code span. A path with a space in it is not recognised.",
  scope: "session",
} as const;
const CARD_COLUMNS = 80;
const CARD_ROWS = 24;
// With the `inline` option the picture sits in the transcript under its chip,
// so it is kept smaller than a hover card.
const INLINE_COLUMNS = 60;
const INLINE_ROWS = 12;
// Images pasted into a prompt are saved under the home directory, as the
// mod's own files, and removed this long after they were pasted.
const PASTE_DIR = ".claude/imgview-pastes";
const PASTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// The store key of a prompt's pasted images: the session and the prompt text.
const PASTE_SUFFIX: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
// Writes standard input, base64, to $2 as bytes, in a folder $1 only the
// person reads. The name is new: noclobber refuses one that is there.
const SAVE_PASTE =
  'umask 077; mkdir -p -- "$1" && set -C && base64 -d >"$2"';
// Writes the clipboard's PNG to $1, a new file. Exit 6: no xclip (Wayland
// without XWayland, macOS); exit 5: the clipboard holds no PNG.
const CLIPBOARD_PNG =
  'command -v xclip >/dev/null || exit 6; ' +
  'xclip -selection clipboard -t TARGETS -o | grep -qx image/png || exit 5; ' +
  'set -C; xclip -selection clipboard -t image/png -o >"$1"';
// Hands $1 to the desktop's default viewer and returns at once, the viewer
// left running on its own. Exit 6: no opener (xdg-open, or macOS's open).
const OPEN_VIEWER =
  'if command -v xdg-open >/dev/null; then o=xdg-open; ' +
  'elif [ "$(uname)" = Darwin ]; then o=open; else exit 6; fi; ' +
  'nohup "$o" "$1" >/dev/null 2>&1 </dev/null &';
// The changes to the prompt box that are not a paste.
const NOT_PASTES = new Set(["history", "clear", "undo", "plugin", "app"]);
const CLIPBOARD_EXIT: Record<number, string> = {
  5: "the clipboard holds no PNG",
  6: "xclip is not installed, so pasted images get no preview before they are sent (X11 only)",
};
// The pixels a card's PNG is given a cell, where the terminal draws pixels.
const CARD_CELL_PIXELS = { width: 10, height: 20 };
// A reply is drawn again for every piece that streams in: a path is looked up
// once in this long, and this many lookups are remembered.
const LOCATE_TTL_MS = 2000;
const MAX_LOCATED = 128;
// This many cards are kept, drawn or waiting to be. One a reply on screen
// draws is in use: a drawn one is not dropped for another, and a waiting one
// keeps its turn. Past the limit a new card waits with no chip. A picture
// that could not be drawn is remembered apart.
const MAX_THUMBS = 32;
const MAX_FAILED = 128;
// The replies remembered as on screen: those that asked for a card. The
// engine says when one scrolls off it, and nothing of one taken out of the
// transcript: such a reply holds its cards until this many others have been
// drawn after it.
const MAX_ON_SCREEN = 64;
// What a reply names is converted with no action of the person's, so it is
// held to less than what `/img` takes: a file this small, a picture of this
// many pixels, `sips` alone, this long, and one conversion at a time.
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const PREVIEW_MAX_PIXELS = 40_000_000;
const PREVIEW_TIMEOUT_MS = 5000;
// More than a preview's commands take at their timeouts, one after another:
// only a file system call that never answers lasts this long, and then the
// card is given up so that the ones behind it are drawn.
const PREVIEW_DEADLINE_MS = 30_000;
// A preview given up may never answer at all. With this many unanswered no
// new card is begun, so they and what they left behind cannot pile up.
const MAX_ABANDONED = 8;
// Copies $1 to $2 under the shell's noclobber, which refuses a file that is
// there and opens with O_EXCL where none is: no copy is made over a file, or
// through a link to one or to nothing. Exit 3 says the shell did not open the
// name (it is taken, or there is no room or no directory for it), and then
// nothing was written. A pipe or a device that sits at the name is opened as
// it is, so what is there afterwards is looked at before it is called a copy.
const SNAPSHOT = 'set -C; { cat -- "$1" || exit 4; } >"$2" || exit 3';
const SNAPSHOT_NOT_OPENED = 3;

const shown = atom({ plugin: "imgview", key: "shown" } as const, null);
// Every temporary file the mod has made and not yet removed, by its path:
// kept with the session, so a module loaded again knows what the last left.
const temps = atom({ plugin: "imgview", key: "temps" } as const, []);
// Counts saved pastes. A prompt can be drawn before its images are saved;
// reading this while drawing makes the row draw again once they are.
const pastesSaved = atom({ plugin: "imgview", key: "pastesSaved" } as const, 0);
const draftsChanged = atom(
  { plugin: "imgview", key: "draftsChanged" } as const,
  0,
);
/** The engine as a hook is handed it, which the session's state is read by. */
type Engine = Parameters<typeof read>[0];
// How far behind the files that record is written: a drawing may write no
// state, so the record is never written from where a file is made.
const RECORD_DELAY_MS = 100;

type Cells = { columns: number; rows: number; cells: string };

/** The cells last painted for one picture at one size, or why they were not. */
type Frame = {
  id: string;
  columns: number;
  rows: number;
  cells?: string;
  error?: string;
};

/**
 * A file a path leads to: where it landed and when it last changed. One with
 * `hasNoCard` (outside the working directory under the `hover` option, or any
 * file where no converter is installed) gets a chip to click and no card:
 * nothing of it is converted before the person asks.
 */
type Located = {
  path: string;
  mtimeMs: number;
  isOutside?: true;
  hasNoCard?: true;
};

/** A chip to draw: the file, and what the chip says. */
type Chip = { file: Located; label: string; name: string };

/**
 * A hover card's picture, measured and converted: cells, or on a terminal
 * that draws pixels a small PNG of the mod's own for it to read.
 */
type Card = Measured & {
  columns: number;
  rows: number;
  cells?: string;
  png?: string;
};

/**
 * A card's place among those kept: no `card` yet while it waits its turn.
 * `askedAt` orders the cards by when a reply on screen last asked for each:
 * a count, not a time, so no two are equal.
 */
type Slot = { card?: Card; askedAt: number };

/**
 * A reply on screen: the cards its last finished drawing asked for, and the
 * ones the drawing of it begun last, if still at work, has asked for so far.
 */
type Reply = { cards: Set<string>; drawing?: Set<string> };

/** What the pane's drawing asks to be converted: a picture at a size. */
type Wanted = {
  id: string;
  picture: Shown;
  box: { columns: number; rows: number };
};

/** A card waiting to be converted, under the working directory it was asked in. */
type Job = {
  id: string;
  file: Located;
  maxColumns: number;
  slot: Slot;
  boundary: number;
};

/** How a conversion is held back: `/img` passes none of these. */
type Limits = {
  /**
   * Where `sips` cannot, ImageMagick reads only the bitmap format the file's
   * first bytes show: never one it would guess, or hand to a delegate such
   * as Ghostscript.
   */
  isSniffed?: boolean;
  timeoutMs?: number;
};

const PREVIEW: Limits = { isSniffed: true, timeoutMs: PREVIEW_TIMEOUT_MS };

/**
 * What the converters need of the engine, bound once at `session.start`: a
 * conversion outlives the drawing that asked for it.
 */
type Host = {
  /** Runs a host command; undefined when it is not installed or timed out. */
  run: (
    argv: readonly string[],
    timeoutMs?: number,
  ) => Promise<{ exitCode: number; stdout: string } | undefined>;
  exists: (path: string) => Promise<boolean>;
  /** What a path leads to, with where it lands; undefined when missing. */
  stat: (path: string) => Promise<
    | {
        kind: string;
        size: number;
        mtimeMs: number;
        realPath?: string;
      }
    | undefined
  >;
  /** A file's bytes, base64. */
  readBytes: (path: string) => Promise<string>;
  /** A fresh path under the temporary directory, its name not guessable. */
  tempPath: (suffix: "bmp" | "png" | "snap") => string;
  /** Writes a path down as a file the mod made, its own to remove. */
  keep: (path: string) => void;
  /** Removes a file the mod made, and strikes its path off. */
  remove: (path: string) => void;
  /**
   * Removes every file written down but the PNG the pane shows: what a
   * module loaded before, or a session that ended, left behind.
   */
  sweep: () => Promise<void>;
  redraw: () => void;
  /** Calls `fn` once after `ms` milliseconds on the engine's clock. */
  after: (ms: number, fn: () => void) => { cancel: () => void };
  home: string | undefined;
  /**
   * Where the session's working directory lands, kept up as it changes;
   * undefined when unknown, and then no reply's mention is previewed.
   */
  root: string | undefined;
  /**
   * kitty and Ghostty draw an Image as pixels, from a file they read
   * themselves: not through tmux, and not across ssh.
   */
  isPixelTerminal: boolean;
  /**
   * Whether `sips` or ImageMagick is on the PATH. Without either every chip
   * is drawn with no card, as for a file outside.
   */
  canPreview: boolean;
};

/**
 * How ImageMagick is to name the file, or undefined where it may not read it:
 * under `isSniffed`, with the format its first bytes show written before it.
 */
async function magickSource(
  host: Host,
  path: string,
  limits: Limits,
): Promise<string | undefined> {
  if (limits.isSniffed !== true) return `${path}[0]`;
  const head = await host.run(
    ["od", "-An", "-tx1", "-N32", "--", path],
    limits.timeoutMs,
  );
  if (head?.exitCode !== 0) return undefined;
  const format = sniffFormat(parseOdBytes(head.stdout));

  return format === undefined
    ? undefined
    : `${format.toUpperCase()}:${path}[0]`;
}

async function measure(
  host: Host,
  path: string,
  limits: Limits = {},
): Promise<Measured | undefined> {
  const sips = await host.run(
    ["sips", "-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", path],
    limits.timeoutMs,
  );
  const size = sips ? parseSipsSize(sips.stdout) : undefined;
  if (size !== undefined) return size;
  // sips ran and could not read it: ImageMagick is not asked to guess.
  if (sips !== undefined && limits.isSniffed === true) return undefined;
  const source = await magickSource(host, path, limits);
  if (source === undefined) return undefined;
  const magick = await host.run(
    ["magick", "identify", "-format", "%w %h %m", source],
    limits.timeoutMs,
  );

  return magick?.exitCode === 0 ? parseIdentifySize(magick.stdout) : undefined;
}

/**
 * Writes the picture to `out` as its suffix says (BMP or PNG), stretched to
 * `size` when given: `sips` first, ImageMagick where sips cannot.
 */
async function convert(
  host: Host,
  path: string,
  out: string,
  size?: Size,
  limits: Limits = {},
): Promise<boolean> {
  const format = out.endsWith(".png") ? "png" : "bmp";
  const resample = size ? ["-z", String(size.height), String(size.width)] : [];
  // sips exits 0 on a file it cannot read: the written file is the proof.
  const sips = await host.run(
    ["sips", "-s", "format", format, ...resample, path, "--out", out],
    limits.timeoutMs,
  );
  const isWritten = await host.exists(out);
  if (isWritten) return true;
  if (sips !== undefined && limits.isSniffed === true) return false;
  const source = await magickSource(host, path, limits);
  if (source === undefined) return false;
  const resize = size ? ["-resize", `${size.width}x${size.height}!`] : [];
  await host.run(["magick", source, ...resize, out], limits.timeoutMs);

  return host.exists(out);
}

/**
 * The picture as `box` cells of quarter blocks, two pixels a cell each way;
 * throws when nothing converts it.
 */
async function rasterize(
  host: Host,
  path: string,
  box: { columns: number; rows: number },
  limits: Limits = {},
): Promise<Cells> {
  const out = host.tempPath("bmp");
  const size = { width: box.columns * 2, height: box.rows * 2 };
  if (!(await convert(host, path, out, size, limits))) {
    throw new Error(
      limits.isSniffed === true
        ? "no converter could read it as a bitmap"
        : "neither sips nor ImageMagick could convert it",
    );
  }
  host.keep(out);
  let base64: string;
  try {
    base64 = await host.readBytes(out);
  } finally {
    host.remove(out);
  }
  const bitmap = decodeBmp(fromBase64(base64));
  if (bitmap.width !== size.width || bitmap.height !== size.height) {
    throw new Error(
      `the converter wrote ${bitmap.width}x${bitmap.height}, not ${size.width}x${size.height}`,
    );
  }

  return toCells(bitmap);
}

/**
 * The file a reply's mention leads to, a `~` expanded and every link
 * followed: a regular file named as a bitmap is where it lands, as the
 * mention was where it was written. One outside the session's working
 * directory is marked so; it has no card, whatever its size, unless
 * `isOutsideCarded` (the `inline` option). Any other is no larger than a
 * preview takes. Undefined for anything else.
 */
async function locateMention(
  host: Host,
  given: string,
  isOutsideCarded: boolean,
): Promise<Located | undefined> {
  if (host.root === undefined) return undefined;
  const found = await host.stat(expandHome(given, host.home));
  if (found?.kind !== "file" || found.realPath === undefined) return undefined;
  // A link named like a picture is taken by the name of what it leads to.
  if (!hasImageSuffix(found.realPath)) return undefined;
  const file: Located = { path: found.realPath, mtimeMs: found.mtimeMs };
  if (!isInside(found.realPath, host.root)) {
    file.isOutside = true;
    if (!isOutsideCarded) return { ...file, hasNoCard: true };
  }
  if (!host.canPreview) return { ...file, hasNoCard: true };
  if (found.size > PREVIEW_MAX_BYTES) return undefined;

  return file;
}

/**
 * The card of a file a reply named, or undefined when it is not a picture a
 * preview takes. Everything is decoded from a copy of the file made first:
 * the copy is the mod's own, so what was checked is what `sips` reads.
 */
async function preview(
  host: Host,
  file: Located,
  maxColumns: number,
  maxRows: number,
): Promise<Card | undefined> {
  const copy = host.tempPath("snap");
  let isCopyMine = false;
  try {
    const copying = await host.run(
      ["/bin/sh", "-c", SNAPSHOT, "sh", file.path, copy],
      PREVIEW_TIMEOUT_MS,
    );
    // The name was not opened: what is there is not the mod's to read or
    // remove.
    if (copying?.exitCode === SNAPSHOT_NOT_OPENED) return undefined;
    // A regular file there is the one the shell made: whole, in part, or cut
    // short at the timeout. Anything else sat there before, and is left.
    const copied = await host.stat(copy);
    if (copied?.kind !== "file") return undefined;
    isCopyMine = true;
    host.keep(copy);
    if (copying?.exitCode !== 0 || copied.size > PREVIEW_MAX_BYTES)
      return undefined;
    // Swapped for another file, a link or a pipe while it was copied: not
    // this one.
    const still = await host.stat(file.path);
    if (
      still?.kind !== "file" ||
      still.realPath !== file.path ||
      still.mtimeMs !== file.mtimeMs
    )
      return undefined;

    const size = await measure(host, copy, PREVIEW);
    if (
      size === undefined ||
      !isBitmapFormat(size.format) ||
      size.width * size.height > PREVIEW_MAX_PIXELS
    )
      return undefined;
    const box = fit(size, maxColumns, maxRows);
    if (host.isPixelTerminal) {
      // A small PNG of the mod's own for the terminal to read, whatever the
      // file's format: never the file the reply named.
      const png = host.tempPath("png");
      const pixels = {
        width: box.columns * CARD_CELL_PIXELS.width,
        height: box.rows * CARD_CELL_PIXELS.height,
      };
      if (await convert(host, copy, png, pixels, PREVIEW)) {
        host.keep(png);

        return { ...size, ...box, png };
      }
    }

    return { ...size, ...(await rasterize(host, copy, box, PREVIEW)) };
  } finally {
    if (isCopyMine) host.remove(copy);
  }
}

/**
 * Whether the terminal can read this picture itself: a PNG by its content,
 * as the converter named it, at an absolute path.
 */
function isReadablePng(path: string, format: string | undefined): boolean {
  return path.startsWith("/") && format === "png";
}

/**
 * The picture the pane is to show next, or undefined when `pixels` mode needs
 * a PNG and nothing converts the file to one. Nothing is removed here: the
 * PNG made for the picture on show goes once the pane has taken this one
 * (`replace`).
 */
async function present(
  host: Host,
  file: Located,
  size: Measured,
  mode: Mode,
): Promise<Shown | undefined> {
  const picture: Shown = {
    path: file.path,
    name: baseName(file.path),
    width: size.width,
    height: size.height,
    mtimeMs: file.mtimeMs,
    mode,
  };
  if (mode === "pixels") {
    // The terminal reads a PNG by its absolute path; anything else is converted.
    if (isReadablePng(file.path, size.format)) {
      picture.png = file.path;
    } else {
      const out = host.tempPath("png");
      if (!(await convert(host, file.path, out))) return undefined;
      host.keep(out);
      picture.png = out;
      picture.isPngTemporary = true;
    }
  }

  return picture;
}

/**
 * Puts a picture in the pane in place of the one there; undefined when it
 * converts to no PNG. The PNG the mod made for the picture replaced goes once
 * the pane has taken the next, and not before. Where the pane does not take
 * it the call fails, the PNG made for the next goes instead, and the picture
 * on show stays as it is. A PNG the pane was shown as it is is the person's,
 * and never removed. One call at a time: each sees the picture it replaces.
 */
async function replace(
  $: Engine,
  host: Host,
  file: Located,
  size: Measured,
  mode: Mode,
): Promise<Shown | undefined> {
  const previous = await read($, shown);
  const picture = await present(host, file, size, mode);
  if (picture === undefined) return undefined;
  try {
    await update($, shown, () => picture);
  } catch (error) {
    if (picture.isPngTemporary === true && picture.png !== undefined)
      host.remove(picture.png);
    throw error;
  }
  if (
    previous?.png !== undefined &&
    previous.isPngTemporary === true &&
    previous.png !== picture.png
  ) {
    host.remove(previous.png);
  }

  return picture;
}

/**
 * What the pane asks of the layout for a picture: inline, the rows the picture
 * fills under the full width; docked, a share of the columns.
 */
/** What the pane asks of the layout. */
type PaneSize = ReturnType<typeof paneRequest>;

function paneRequest(picture: Shown, columns: number) {
  const inline = fit(
    picture,
    Math.min(Math.max(1, columns - 4), MAX_CELLS),
    24,
  );

  return {
    id: PANE,
    title: picture.name,
    closeOnEscape: true as const,
    rows: inline.rows + 1,
    columns: Math.max(40, Math.min(100, Math.round(columns * 0.45))),
  };
}

/** The images pasted with one prompt, as the store keeps them. */
type Pasted = { paths: string[]; savedAt: number };

function isPasted(value: unknown): value is Pasted {
  if (typeof value !== "object" || value === null) return false;
  const { paths, savedAt } = value as Record<string, unknown>;

  return (
    Array.isArray(paths) &&
    paths.every((path) => typeof path === "string") &&
    typeof savedAt === "number"
  );
}

/** The images pasted with a prompt, by its key: `cache` first, then the store. */
async function pastesOf(
  $: EngineInterface,
  cache: Map<string, string[]>,
  key: string,
): Promise<string[]> {
  const known = cache.get(key);
  if (known !== undefined) return known;
  const stored = await $.store.get(key);
  const paths = isPasted(stored) ? stored.paths : [];
  cache.set(key, paths);

  return paths;
}

/**
 * Saves one pasted image as a file of the mod's own, and answers its path.
 * Throws with the reason when the engine gives no bytes or the shell
 * writes none.
 */
async function savePaste(
  $: EngineInterface,
  dir: string,
  id: string,
): Promise<string> {
  let base64 = "";
  let mediaType: string | undefined;
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const part = await $.prompt.media({ id, offset });
    if (part.deny !== undefined) throw new Error(part.deny);
    if (part.unreadable !== undefined) throw new Error(part.unreadable);
    base64 += part.base64;
    mediaType = part.mediaType;
    offset = part.next;
  }
  const suffix = mediaType === undefined ? undefined : PASTE_SUFFIX[mediaType];
  if (suffix === undefined)
    throw new Error(`not a picture type the mod saves: ${mediaType}`);
  const path = `${dir}/${crypto.randomUUID()}.${suffix}`;
  const done = await $.process.run(
    ["/bin/sh", "-c", SAVE_PASTE, "sh", dir, path],
    { stdin: base64, timeoutMs: PREVIEW_TIMEOUT_MS },
  );
  if (done.exitCode !== 0)
    throw new Error(`the shell exited ${done.exitCode}: ${done.stderr}`);

  return path;
}

/**
 * Copies the clipboard's picture to `path`, a new file: Claude Code gives a
 * pasted image to no hook before the prompt is sent, and it took this one
 * from the clipboard. Throws with the reason when none is written.
 */
async function captureClipboard($: EngineInterface, path: string) {
  const done = await $.process.run(["/bin/sh", "-c", CLIPBOARD_PNG, "sh", path], {
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
  if (done.exitCode !== 0)
    throw new Error(
      CLIPBOARD_EXIT[done.exitCode] ?? `the shell exited ${done.exitCode}: ${done.stderr}`,
    );
}

/** Opens the file in the desktop's default image viewer, or says why not. */
async function openInViewer($: EngineInterface, path: string) {
  const done = await $.process.run(["/bin/sh", "-c", OPEN_VIEWER, "sh", path], {
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
  if (done.exitCode === 0) return;
  const reason =
    done.exitCode === 6
      ? "no xdg-open (Linux) or open (macOS) to hand it to"
      : `the shell exited ${done.exitCode}: ${done.stderr}`;
  const line = `imgview: could not open ${path} in a viewer: ${reason}`;
  $.ui.log(line, { to: "debug" });
  $.ui.toast(line);
}

/** Says, as a toast and in the debug log, why a pasted image was not kept. */
function tellPasteFailure($: EngineInterface, error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  const line = `imgview: could not save a pasted image: ${reason}`;
  $.ui.toast(line);
  $.ui.log(line, { to: "debug" });
}

/**
 * Removes the pasted images saved more than `PASTE_MAX_AGE_MS` ago, and the
 * store's record of each prompt that old.
 */
async function forgetOldPastes(
  $: EngineInterface,
  io: Host,
  dir: string | undefined,
) {
  const cutoff = (await $.clock.now()) - PASTE_MAX_AGE_MS;
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PASTE_KEY)) continue;
    const stored = await $.store.get(key);
    if (!isPasted(stored) || stored.savedAt < cutoff) await $.store.delete(key);
  }
  if (dir === undefined || !(await io.exists(dir))) return;
  const old = (await $.fs.list(dir))
    .filter((entry) => entry.kind === "file" && entry.mtimeMs < cutoff)
    .map((entry) => `${dir}/${entry.name}`);
  if (old.length === 0) return;
  const done = await io.run(["rm", "-f", "--", ...old]);
  if (done?.exitCode !== 0)
    $.ui.log(`imgview: could not remove ${old.length} old pasted images`, {
      to: "debug",
    });
}

/**
 * A click is the person's: the pane takes the file itself, as it is now
 * and not as it was when the card was drawn. `inTurn` runs one pane change
 * at a time; `sized` says what the pane asks of the layout.
 */
async function openFile(
  $: EngineInterface,
  io: Host,
  file: Located,
  name: string,
  columns: number,
  inTurn: <T>(work: () => Promise<T>) => Promise<T>,
  sized: (picture: Shown, columns: number, isUp: boolean) => PaneSize,
) {
  const found = await io.stat(file.path);
  if (found?.kind !== "file") {
    $.ui.toast(`imgview: not a file any more: ${name}`);

    return;
  }
  const fresh = {
    path: found.realPath ?? file.path,
    mtimeMs: found.mtimeMs,
  };
  const size = await measure(io, fresh.path);
  if (size === undefined) {
    $.ui.toast(`imgview: not an image sips or ImageMagick can read: ${name}`);

    return;
  }
  const mode = io.isPixelTerminal ? "pixels" : "cells";
  let picture: Shown | undefined;
  try {
    picture = await inTurn(() => replace($, io, fresh, size, mode));
  } catch {
    $.ui.toast(`imgview: could not show ${name}, try again`);

    return;
  }
  if (picture === undefined) {
    $.ui.toast(`imgview: could not convert to PNG: ${name}`);

    return;
  }
  const isUp = (await $.ui.panes()).some((pane) => pane.id === PANE);
  await $.ui.open(sized(picture, columns, isUp));
}

/**
 * Whether a message is on screen, from its `onScreen` prop: null when it is
 * off screen, and undefined where the surface does not say.
 */
function isOnScreen(onScreen: object | null | undefined): boolean | undefined {
  return onScreen === undefined ? undefined : onScreen !== null;
}

export const register: Register = (on, options) => {
  // `inline`: each chip's picture is drawn under it, for every file, in the
  // working directory or not. `hover`: hidden over the rows above until the
  // pointer is on the chip, and none for a file outside.
  const isInline = options.preview === "inline";
  const cardColumns = isInline ? INLINE_COLUMNS : CARD_COLUMNS;
  const cardRows = isInline ? INLINE_ROWS : CARD_ROWS;
  // The session the pasted images are kept under, and where they are saved.
  let sessionId: string | undefined;
  let pasteDir: string | undefined;
  // The store's answers, by key: a prompt's pasted images, or none.
  const pastes = new Map<string, string[]>();
  let host: Host | undefined;
  let frame: Frame | undefined;
  // Whether the pane has a conversion in flight, and what its last drawing
  // asked for.
  let isPainting = false;
  let wanted: Wanted | undefined;
  // The temporary files the mod has made and not removed: what the session's
  // record is written from.
  const owned = new Set<string>();
  const thumbs = new Map<string, Slot>();
  // Counts up each time a reply on screen asks for a card.
  let asked = 0;
  // The replies on screen by the engine's id for each, the one drawn longest
  // ago first. The engine draws a reply again as it comes on screen and as it
  // leaves, and not in between: a reply is on screen until it is said to go.
  const onScreen = new Map<string, Reply>();
  // The previews given up that have not answered since.
  let abandoned = 0;
  // Pictures no preview could draw, oldest first: they hold no card's place.
  const failed = new Set<string>();
  const located = new Map<string, { at: number; file: Located | undefined }>();
  // Cards waiting to be converted: one at a time, never side by side.
  const queue: Job[] = [];
  let isPreviewing = false;
  // Moves on when the working directory does: what was started before is void.
  let boundary = 0;
  // The pane's picture is replaced by one caller at a time, so each one sees
  // the picture it really replaces.
  let replacing: Promise<unknown> = Promise.resolve();
  // The width the dock was asked for when the pane was opened, kept for as
  // long as the pane is up. A docked pane narrows the conversation, so a share
  // of the conversation's width taken anew at every open never comes to rest.
  let dockColumns: number | undefined;
  // Counts the sweeps: one that ran across the pane's conversion took its
  // bitmap from under it.
  let sweeps = 0;
  // A mention on screen was left without a chip for want of room among the
  // cards: once room is made, the replies are drawn again.
  let isStarved = false;

  /** What the pane asks of the layout for a picture, up already or not. */
  function sized(picture: Shown, columns: number, isUp: boolean) {
    const request = paneRequest(picture, columns);
    if (!isUp || dockColumns === undefined) dockColumns = request.columns;

    return { ...request, columns: dockColumns };
  }

  function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const done = replacing.then(work, work);
    replacing = done.catch(() => undefined);

    return done;
  }

  /**
   * Converts what the pane wants to cells and asks for the redraw: one
   * conversion at a time. Where the pane has moved on to another size or
   * picture meanwhile, the one it wants by then is next, and none between.
   */
  async function paint(io: Host) {
    if (isPainting) return;
    isPainting = true;
    try {
      for (;;) {
        const job = wanted;
        if (job === undefined || frame?.id === job.id) return;
        let painted: Frame = { id: job.id, ...job.box };
        const swept = sweeps;
        try {
          painted = {
            id: job.id,
            ...(await rasterize(io, job.picture.path, job.box)),
          };
        } catch (error) {
          // A sweep removed the bitmap before it was read: converted again.
          if (swept !== sweeps) continue;
          painted.error =
            error instanceof Error ? error.message : String(error);
          // The pane outlives the file it shows: removed since, that is the
          // reason to give, not the converters.
          if ((await io.stat(job.picture.path))?.kind !== "file")
            painted.error = "the file is no longer there";
        }
        if (wanted?.id !== job.id) continue;
        frame = painted;
        io.redraw();

        return;
      }
    } finally {
      isPainting = false;
    }
  }

  /** Forgets a card, and removes the PNG the mod made for it. */
  function dropThumb(io: Host, id: string) {
    const png = thumbs.get(id)?.card?.png;
    thumbs.delete(id);
    if (png !== undefined) io.remove(png);
  }

  /** Forgets every card and every reply, with no file removed. */
  function forgetCards() {
    thumbs.clear();
    queue.length = 0;
    onScreen.clear();
  }

  /**
   * Room was made among the cards. Where a mention was left without a chip
   * for want of it, the replies are drawn again: after the drawing this is
   * called from, since the engine draws a reply that sits still no other way.
   */
  function freed() {
    if (!isStarved || host === undefined) return;
    isStarved = false;
    const io = host;
    io.after(0, () => io.redraw());
  }

  /** Notes a reply as on screen, the one drawn last of them. */
  function enter(requestId: string): Reply {
    const reply = onScreen.get(requestId) ?? { cards: new Set() };
    onScreen.delete(requestId);
    onScreen.set(requestId, reply);

    return reply;
  }

  /**
   * Holds the record to `MAX_ON_SCREEN` replies: past that the one drawn
   * longest ago goes, and its cards are in use no more.
   */
  function trim() {
    for (const [stale, reply] of onScreen) {
      if (onScreen.size <= MAX_ON_SCREEN) break;
      onScreen.delete(stale);
      if (reply.cards.size > 0) freed();
    }
  }

  /** Notes a reply as on screen no longer: its cards are in use no more. */
  function leave(requestId: string) {
    const reply = onScreen.get(requestId);
    if (reply === undefined) return;
    onScreen.delete(requestId);
    pruneQueue();
    if (reply.cards.size > 0 || (reply.drawing?.size ?? 0) > 0) freed();
  }

  /** Whether a reply on screen draws this card, or is being drawn with it. */
  function isInUse(id: string): boolean {
    for (const reply of onScreen.values()) {
      if (reply.cards.has(id) || reply.drawing?.has(id) === true) return true;
    }

    return false;
  }

  /**
   * Gives up the waiting cards no reply on screen draws: they scrolled away
   * before their turn came.
   */
  function pruneQueue() {
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i]!;
      if (isInUse(job.id)) continue;
      queue.splice(i, 1);
      if (thumbs.get(job.id) === job.slot) thumbs.delete(job.id);
    }
  }

  /**
   * Makes room for one more card: true while fewer than `MAX_THUMBS` are
   * kept, or once one that is drawn is on screen no longer, and then the one
   * asked for longest ago goes. The card being converted is never the one.
   * None is made while too many previews given up are unanswered.
   */
  function admitThumb(io: Host): boolean {
    if (abandoned >= MAX_ABANDONED) return false;
    pruneQueue();
    if (thumbs.size < MAX_THUMBS) return true;
    let oldest: string | undefined;
    for (const [id, slot] of thumbs) {
      if (slot.card === undefined || isInUse(id)) continue;
      if (oldest === undefined || slot.askedAt < thumbs.get(oldest)!.askedAt)
        oldest = id;
    }
    if (oldest === undefined) return false;
    dropThumb(io, oldest);

    return true;
  }

  /**
   * A job's card, or undefined when it has none or was not drawn in time: a
   * call that never answers must not hold up the cards behind it.
   */
  function previewInTime(io: Host, job: Job): Promise<Card | undefined> {
    return new Promise((resolve) => {
      let isLate = false;
      // The command the preview began last, and the files it holds.
      let running: Promise<unknown> = Promise.resolve();
      const held = new Set<string>();
      const bound: Host = {
        ...io,
        // Once given up, the preview starts no command.
        run: (argv, timeoutMs) => {
          if (isLate) return Promise.resolve(undefined);
          const result = io.run(argv, timeoutMs);
          running = result;

          return result;
        },
        keep: (path) => {
          io.keep(path);
          // Too late to be of use: a file found only now goes at once.
          if (isLate) io.remove(path);
          else held.add(path);
        },
        remove: (path) => {
          if (held.delete(path)) io.remove(path);
        },
      };
      const giveUp = () => {
        for (const path of held) io.remove(path);
        held.clear();
        resolve(undefined);
      };
      const deadline = io.after(PREVIEW_DEADLINE_MS, () => {
        isLate = true;
        abandoned++;
        // A command begun before now ends at its own timeout, and the next
        // card waits for that: no two conversions run side by side. Then the
        // files this preview holds go, whether or not it ever answers.
        void running.then(giveUp, giveUp);
      });
      const settle = (card: Card | undefined) => {
        deadline.cancel();
        if (isLate) {
          abandoned--;
          // Cards are begun again from here: the mentions left without a
          // chip meanwhile get theirs with this drawing.
          if (abandoned === MAX_ABANDONED - 1) io.redraw();
        }
        // Too late to be a card: its PNG went as it was kept.
        resolve(isLate ? undefined : card);
      };
      // Rejected: not a picture sips converts, and the chip is dropped.
      preview(bound, job.file, job.maxColumns, cardRows).then(settle, () =>
        settle(undefined),
      );
    });
  }

  /**
   * Converts the waiting cards one after another, the one asked for last
   * first, and asks for the redraw as each is drawn or given up.
   */
  async function drain(io: Host) {
    if (isPreviewing) return;
    isPreviewing = true;
    try {
      for (;;) {
        pruneQueue();
        // Too many previews given up are unanswered: no other is begun, and
        // the cards that waited their turn are given up with them.
        if (abandoned >= MAX_ABANDONED) {
          for (const job of queue.splice(0)) {
            if (thumbs.get(job.id) === job.slot) thumbs.delete(job.id);
          }

          return;
        }
        let next = -1;
        for (let i = 0; i < queue.length; i++) {
          if (next < 0 || queue[i]!.slot.askedAt > queue[next]!.slot.askedAt)
            next = i;
        }
        if (next < 0) return;
        const job = queue.splice(next, 1)[0]!;
        const card = await previewInTime(io, job);
        // The working directory moved on meanwhile, and took the place with it.
        if (job.boundary !== boundary || thumbs.get(job.id) !== job.slot) {
          if (card?.png !== undefined) io.remove(card.png);
        } else if (card === undefined) {
          thumbs.delete(job.id);
          failed.add(job.id);
          for (const stale of failed) {
            if (failed.size <= MAX_FAILED) break;
            failed.delete(stale);
          }
        } else {
          job.slot.card = card;
        }
        io.redraw();
      }
    } finally {
      isPreviewing = false;
    }
  }

  /** Takes a card's place at once and puts its conversion in the queue. */
  function sketch(io: Host, file: Located, id: string, maxColumns: number) {
    const slot: Slot = { askedAt: ++asked };
    thumbs.set(id, slot);
    queue.push({ id, file, maxColumns, slot, boundary });
    void drain(io);
  }

  const drafts = new Drafts();

  on("session.start", async ($, e, next) => {
    const dir = tempDir(await $.env.get("TMPDIR"));
    let root: string | undefined;
    try {
      root = (await $.fs.stat(e.cwd, { resolve: true })).realPath;
    } catch {
      // no working directory to hold previews to: none is drawn
    }
    const run: Host["run"] = async (argv, timeoutMs) => {
      try {
        return await $.process.run(
          argv,
          timeoutMs === undefined ? undefined : { timeoutMs },
        );
      } catch {
        return undefined;
      }
    };
    // The record follows `owned` a moment behind, from a timer of its own.
    let isRecordDue = false;
    const writeRecord = async () => {
      isRecordDue = false;
      try {
        await update($, temps, () => [...owned]);
      } catch {
        // Refused while a reply was being drawn: once more, a moment later.
        record();
      }
    };
    const record = () => {
      if (isRecordDue) return;
      isRecordDue = true;
      $.clock.after(RECORD_DELAY_MS, () => void writeRecord());
    };
    host = {
      run,
      exists: (path) => $.fs.exists(path),
      stat: async (path) => {
        try {
          return await $.fs.stat(path, { resolve: true });
        } catch {
          return undefined;
        }
      },
      readBytes: async (path) =>
        (await $.fs.read(path, { as: "bytes" })).base64,
      tempPath: (suffix) =>
        `${dir}/${TEMP_PREFIX}${crypto.randomUUID()}.${suffix}`,
      keep: (path) => {
        owned.add(path);
        record();
      },
      // A path is struck off once `rm` has said it is gone, and not before:
      // one that could not be removed stays written down for the next sweep.
      remove: (path) => {
        void run(["rm", "-f", path]).then((done) => {
          if (done?.exitCode !== 0) return;
          owned.delete(path);
          record();
        });
      },
      sweep: async () => {
        sweeps++;
        const pane = await read($, shown);
        const kept = pane?.isPngTemporary === true ? pane.png : undefined;
        const left = [...owned].filter((path) => path !== kept);
        if (left.length > 0) {
          const done = await run(["rm", "-f", ...left]);
          if (done?.exitCode === 0) for (const path of left) owned.delete(path);
        }
        await writeRecord();
      },
      redraw: () => $.ui.invalidate("ui.render"),
      after: (ms, fn) => $.clock.after(ms, fn),
      home: await $.env.get("HOME"),
      root,
      isPixelTerminal:
        (await $.env.get("TMUX")) === undefined &&
        (await $.env.get("SSH_CONNECTION")) === undefined &&
        (await $.env.get("SSH_CLIENT")) === undefined &&
        (await $.env.get("SSH_TTY")) === undefined &&
        ((await $.env.get("TERM")) === "xterm-kitty" ||
          (await $.env.get("TERM")) === "xterm-ghostty" ||
          (await $.env.get("TERM_PROGRAM"))?.toLowerCase() === "ghostty" ||
          (await $.env.get("KITTY_WINDOW_ID")) !== undefined),
      canPreview:
        (await run(["/bin/sh", "-c", "command -v sips || command -v magick"]))
          ?.exitCode === 0,
    };
    if (!host.canPreview) {
      $.ui.log(
        "imgview: neither sips nor ImageMagick found, so chips have no picture; click a chip to open it",
        { to: "debug" },
      );
    }
    sessionId = await $.session.id();
    pasteDir = host.home === undefined ? undefined : `${host.home}/${PASTE_DIR}`;
    pastes.clear();
    await forgetOldPastes($, host, pasteDir);
    // A module loaded again starts with no card: the files the last one made
    // for its own go, each by the path it was written down under.
    owned.clear();
    for (const path of await read($, temps)) owned.add(path);
    forgetCards();
    await host.sweep();
    // After the sweep, which removes every copy kept before it.
    await captureDeferred($, drafts, host);
    await $.command.register({
      name: "img",
      description: "Preview an image in a pane",
      argumentHint: "[--cells|--pixels] <path>",
    });

    return next(e);
  });

  // The previews' boundary is the working directory as it is now. When it
  // changes, everything made under the old one is dropped before anything is
  // awaited, and no preview is made until the new one is resolved.
  on("classic.CwdChanged", async (_$, e, next) => {
    if (host !== undefined) {
      const io = host;
      const mine = ++boundary;
      io.root = undefined;
      for (const id of [...thumbs.keys()]) dropThumb(io, id);
      queue.length = 0;
      onScreen.clear();
      failed.clear();
      located.clear();
      // The cards on screen are the old directory's: they go now, not when
      // the new one is known.
      io.redraw();
      const root = (await io.stat(e.new_cwd))?.realPath;
      // A later change owns the root now: this one's answer is stale.
      if (mine === boundary) {
        io.root = root;
        io.redraw();
      }
    }

    return next(e);
  });

  // The session's replies go with it, and their cards with them. The PNG the
  // pane shows stays: after a `/clear` the pane is still there to show it.
  on("session.end", async (_$, e, next) => {
    if (host !== undefined) {
      forgetCards();
      await host.sweep();
    }

    return next(e);
  });

  // On a terminal, where chips are drawn and `/img` answers, the system
  // prompt ends with the hint. No other section is touched.
  on("prompt.compose", async (_$, e, next) => {
    const composed = await next(e);
    if (!e.surfaces.includes("terminal")) return composed;

    return { sections: [...composed.sections, HINT] };
  });

  on("command.run", { command: "img" }, async ($, e) => {
    if (host === undefined)
      return { text: "img: not ready, the session has not started" };
    const io = host;
    const request = parseArgs(e.args);
    // No path: the picture already shown, opened again or drawn the other way.
    const target =
      request.path === "" ? (await read($, shown))?.path : request.path;
    if (target === undefined) return { text: USAGE };

    // A path completed with `@` keeps its mention mark: try it without.
    const candidates = target.startsWith("@")
      ? [target, target.slice(1)]
      : [target];
    let found: Awaited<ReturnType<Host["stat"]>>;
    let given = target;
    for (given of candidates) {
      found = await io.stat(expandHome(given, io.home));
      if (found !== undefined) break;
    }
    if (found === undefined) return { text: `img: no such file: ${target}` };
    if (found.kind !== "file") return { text: `img: not a file: ${target}` };

    given = expandHome(given, io.home);
    const file = {
      path: found.realPath ?? (given.startsWith("/") ? given : `./${given}`),
      mtimeMs: found.mtimeMs,
    };
    const size = await measure(io, file.path);
    if (size === undefined)
      return {
        text: `img: not an image sips or ImageMagick can read: ${target}`,
      };

    const mode = request.mode ?? (io.isPixelTerminal ? "pixels" : "cells");
    let picture: Shown | undefined;
    try {
      picture = await oneAtATime(() => replace($, io, file, size, mode));
    } catch {
      return { text: `img: could not show ${target}, try again` };
    }
    if (picture === undefined)
      return { text: `img: could not convert to PNG: ${target}` };
    const isUp = (await $.ui.panes()).some((pane) => pane.id === PANE);
    await $.ui.open(sized(picture, e.presentation.columns, isUp));

    return {
      text: `${picture.name} · ${picture.width}×${picture.height} · ${mode}`,
    };
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    if (e.surface !== "terminal") {
      const { Text } = $.ui.resolve(e);

      return <Text dimColor>imgview draws pictures in the terminal only.</Text>;
    }
    const { Box, Button, Image, Raster, Text } = $.ui.resolve(e);
    const picture = await read($, shown);
    if (picture === null) return <Text dimColor>{USAGE}</Text>;

    const caption = `${picture.name} · ${picture.width}×${picture.height}`;
    // The pane is narrow: the viewer shows the picture at full size, zoomable.
    const footer = (
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>{caption}</Text>
        <Button
          key="imgview-viewer"
          plain
          dimColor
          hotkey="o"
          label="open in viewer"
          onPress={() => openInViewer($, picture.path)}
        />
      </Box>
    );
    const box = fit(
      picture,
      Math.min(e.props.bodyColumns, MAX_CELLS),
      Math.min(e.props.scroll.bodyRows - 1, MAX_CELLS),
    );
    if (picture.mode === "pixels" && picture.png !== undefined) {
      return (
        <Box flexDirection="column">
          <Image
            key={KEY}
            source={{
              file: picture.png,
              format: "png",
              generation: Math.floor(picture.mtimeMs),
            }}
            columns={box.columns}
            rows={box.rows}
            alt={`${caption}: no pixels on this terminal, try /img --cells`}
          />
          {footer}
        </Box>
      );
    }

    const id = `${picture.path}|${picture.mtimeMs}|${box.columns}x${box.rows}`;
    wanted = { id, picture, box };
    if (host !== undefined && frame?.id !== id) void paint(host);
    if (frame?.id === id && frame.error !== undefined) {
      return <Text dimColor>{`${caption}: ${frame.error}`}</Text>;
    }

    // While another size is converted, the last frame of this picture stays up.
    const isSamePicture =
      frame?.id.startsWith(`${picture.path}|${picture.mtimeMs}|`) === true;
    return (
      <Box flexDirection="column">
        {frame?.cells !== undefined && isSamePicture ? (
          <Raster
            key={KEY}
            columns={frame.columns}
            rows={frame.rows}
            cells={frame.cells}
          />
        ) : (
          <Text dimColor>Rendering…</Text>
        )}
        {footer}
      </Box>
    );
  });

  /**
   * Draws the chips under a message, one a file `find` answers. A click opens
   * the pane. Under `hover` the pointer on a chip reveals a card with the
   * picture over the rows above: the surface applies the hover itself, so the
   * card is drawn ahead of it, hidden, while the message is on screen. Under
   * `inline` the picture is drawn under its chip.
   */
  async function withChips(
    e: RenderInput<"AssistantMessage" | "UserMessage" | "AbovePrompt", "terminal">,
    row: RenderElement,
    // Whether any of it is on screen; undefined where the surface does not say.
    isOnScreen: boolean | undefined,
    elements: Elements["terminal"],
    onOpen: (
      io: Host,
      file: Located,
      name: string,
      columns: number,
    ) => Promise<void>,
    find: (io: Host) => Promise<Chip[]>,
  ): Promise<RenderElement> {
    if (host === undefined) return row;
    // Only the fullscreen terminal reports the pointer. A message that draws
    // no chip, there or for want of a file, holds no card either.
    if (e.viewport?.isFullscreen !== true) {
      leave(e.requestId);

      return row;
    }

    const { Box, Button, Image, Raster, Text } = elements;
    const io = host;
    // Where the terminal does not say what is on screen, nothing is taken to
    // be: the chips are drawn, and no card is made or drawn for them.
    const reply = isOnScreen === true ? enter(e.requestId) : undefined;
    // Inline, a picture's rows are kept whether it is drawn or not: on screen
    // or off, converting, waiting for room or failed. A message that changed
    // height as it scrolled in or out would move the view back to it.
    const isReserved = isInline && isOnScreen !== undefined;
    if (reply === undefined) leave(e.requestId);
    // The cards this drawing asks for. They are the message's own once the
    // drawing is done, and no other drawing's set is touched meanwhile.
    const cards = new Set<string>();
    if (reply !== undefined) reply.drawing = cards;
    const columns = e.viewport.columns;
    const maxColumns = Math.max(16, Math.min(cardColumns, columns - 12));
    const drawnUnder = boundary;
    const found = await find(io);
    const chips = [];
    let offset = 0;
    // Whether a file of this message's asks for a card, got or not.
    let isAsking = false;
    for (const { file, label, name } of found) {
      const id = `${file.path}|${file.mtimeMs}|${maxColumns}`;
      const hasFailed = failed.has(id);
      // A hover chip with no picture to show is left out; a reserved one
      // stays, with its rows.
      if (hasFailed && !isReserved) continue;
      const slot = thumbs.get(id);
      // Only the drawing begun last of a message still on screen asks for a
      // card, holds one in use, or draws one, and none does for a file
      // that has no card.
      const isHolding =
        !hasFailed &&
        file.hasNoCard !== true &&
        reply !== undefined &&
        reply.drawing === cards &&
        onScreen.get(e.requestId) === reply;
      if (file.hasNoCard !== true && !hasFailed) isAsking = true;
      if (isHolding) {
        // No room among the cards on screen: this one waits, with no chip
        // unless its rows are reserved.
        if (slot === undefined && !admitThumb(io)) {
          isStarved = true;
          if (!isReserved) continue;
        } else {
          cards.add(id);
          if (slot !== undefined) slot.askedAt = ++asked;
          else sketch(io, file, id, maxColumns);
        }
      }
      const card = slot?.card;

      const index = chips.length;
      const width = card === undefined ? 16 : card.columns;
      const caption = (
        card === undefined
          ? "Rendering…"
          : `${name} · ${card.width}×${card.height}`
      )
        .slice(0, width)
        .padEnd(width);
      const picture =
        card?.png !== undefined ? (
          <Image
            key={`imgview-thumb-${index}`}
            source={{ file: card.png, format: "png" }}
            columns={card.columns}
            rows={card.rows}
            alt={name}
          />
        ) : card?.cells !== undefined ? (
          <Raster
            key={`imgview-thumb-${index}`}
            columns={card.columns}
            rows={card.rows}
            cells={card.cells}
          />
        ) : undefined;
      chips.push(
        <Box
          key={`imgview-chip-${index}`}
          flexDirection={isInline ? "column" : "row"}
        >
          <Button
            key={`imgview-open-${index}`}
            plain
            dimColor
            label={label}
            onPress={() => onOpen(io, file, name, columns)}
          />
          {isReserved && file.hasNoCard !== true && (
            <Box
              key={`imgview-slot-${index}`}
              height={cardRows}
              overflow="hidden"
              flexDirection="column"
            >
              {hasFailed ? (
                <Text dimColor>No preview</Text>
              ) : isHolding ? (
                (picture ?? <Text dimColor>Rendering…</Text>)
              ) : undefined}
            </Box>
          )}
          {isHolding && !isInline && (
            <Box
              position="absolute"
              top={-((card === undefined ? 1 : card.rows + 1) + 2)}
              left={0 - offset}
              display="none"
              hover={{ display: "flex" }}
              flexDirection="column"
              borderStyle="round"
            >
              {picture}
              <Text dimColor>{caption}</Text>
            </Box>
          )}
        </Box>,
      );
      offset += label.length + 2;
    }
    // The drawing of a message begun last says which cards it draws now.
    if (reply !== undefined && reply.drawing === cards) {
      reply.drawing = undefined;
      // A card it drew before and draws no longer is in use no more.
      const isLetGo = [...reply.cards].some((id) => !cards.has(id));
      reply.cards = cards;
      if (onScreen.get(e.requestId) === reply) {
        // A message that asked for no card (its files are missing, refused
        // or have none) takes no place among those that did.
        if (isAsking) trim();
        else onScreen.delete(e.requestId);
        if (isLetGo) {
          pruneQueue();
          freed();
        }
      }
    }
    // The working directory changed while this was drawn: what it found is
    // the old one's, and the drawing that change asked for draws the new.
    if (drawnUnder !== boundary) return row;
    if (chips.length === 0) return row;

    return (
      <Box flexDirection="column">
        {row}
        <Box
          flexDirection={isInline ? "column" : "row"}
          columnGap={2}
          marginLeft={2}
        >
          {chips}
        </Box>
      </Box>
    );
  }

  // Under a reply that names image files: one chip a file.
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    const row = await next(e);
    if (e.surface !== "terminal") return row;
    const mentions = findImagePaths(e.props.text, MAX_CHIPS);
    if (mentions.length === 0) {
      leave(e.requestId);

      return row;
    }

    return withChips(
      e,
      row,
      isOnScreen(e.props.onScreen),
      $.ui.resolve(e),
      (io, file, name, columns) =>
        openFile($, io, file, name, columns, oneAtATime, sized),
      async (io) => {
      const chips: Chip[] = [];
      for (const mention of mentions) {
        const now = await $.clock.now();
        // Between two working directories nothing is looked up, or
        // remembered: asked once the clock has answered, behind which a
        // change may have come.
        if (io.root === undefined) break;
        let entry = located.get(mention);
        if (entry === undefined || now - entry.at > LOCATE_TTL_MS) {
          const asked = boundary;
          entry = {
            at: now,
            file: await locateMention(io, mention, isInline),
          };
          // Looked up under a working directory that has since changed.
          if (asked !== boundary) continue;
          located.delete(mention);
          if (located.size >= MAX_LOCATED) {
            for (const [key, old] of located) {
              if (now - old.at > LOCATE_TTL_MS) located.delete(key);
            }
          }
          // Still full of fresh lookups: the oldest of them goes.
          for (const key of located.keys()) {
            if (located.size < MAX_LOCATED) break;
            located.delete(key);
          }
          located.set(mention, entry);
        }
        const file = entry.file;
        if (file === undefined) continue;
        const name = baseName(file.path);
        const label =
          file.isOutside === true
            ? `▣ ${shortenPath(file.path, io.home, OUTSIDE_LABEL_MAX)}`
            : `▣ ${name}`;
        chips.push({ file, label, name });
      }

      return chips;
    });
  });

  // Images pasted into a prompt are saved before the prompt goes on, while
  // the engine still answers for their bytes. A failure is told, and the
  // prompt goes on all the same.
  on("prompt.submit", async ($, e, next) => {
    // What was pasted is sent now: the band above the prompt lets it go.
    await syncDrafts($, drafts, host, "", false);
    const images = (e.attachments ?? []).filter(
      (item) => item.type === "image" && item.id !== undefined,
    );
    if (images.length === 0 || pasteDir === undefined || sessionId === undefined)
      return next(e);
    const key = pasteKey(sessionId, e.text);
    try {
      const paths: string[] = [];
      for (const item of images) {
        try {
          paths.push(await savePaste($, pasteDir, item.id!));
        } catch (error) {
          tellPasteFailure($, error);
        }
      }
      if (paths.length > 0) {
        const stored: Pasted = { paths, savedAt: await $.clock.now() };
        await $.store.set(key, stored);
        pastes.set(key, paths);
        await update($, pastesSaved, (count) => count + 1);
      }
    } catch (error) {
      tellPasteFailure($, error);
    }

    return next(e);
  });

  // Under a prompt sent with pasted images: one chip an image.
  on("ui.render", { component: "UserMessage" }, async ($, e, next) => {
    const row = await next(e);
    if (e.surface !== "terminal") return row;
    await read($, pastesSaved);
    const paths =
      sessionId === undefined
        ? []
        : await pastesOf($, pastes, pasteKey(sessionId, e.props.text));
    if (paths.length === 0) {
      leave(e.requestId);

      return row;
    }
    const numbers = pastedImageNumbers(e.props.text);
    const isNumbered = numbers.length === paths.length;
    if (!isNumbered)
      $.ui.log(
        `imgview: ${paths.length} saved pastes but ${numbers.length} [Image #N] in the prompt, so chips count from 1`,
        { to: "debug" },
      );

    return withChips(
      e,
      row,
      isOnScreen(e.props.onScreen),
      $.ui.resolve(e),
      (io, file, name, columns) =>
        openFile($, io, file, name, columns, oneAtATime, sized),
      (io) =>
        pastedChips(
          io,
          paths.map((path, i) => ({ path, number: isNumbered ? numbers[i]! : i + 1 })),
        ),
    );
  });

  // Typing or deleting in the box: an image's `[Image #N]` may go with it.
  on("prompt.edit", async ($, e, next) => {
    const result = await next(e);
    await syncDrafts($, drafts, host, result.text, true);

    return result;
  });

  // Claude Code puts a pasted image's `[Image #N]` in the box as an `engine`
  // change. A recalled entry, an undo or a plugin's fill brings back an
  // `[Image #N]` whose picture is not on the clipboard: none is taken for it.
  on("prompt.change", async ($, e, next) => {
    const isPaste = !NOT_PASTES.has(e.origin.kind);
    await syncDrafts($, drafts, host, e.text, isPaste);

    return next(e);
  });

  // Above the prompt box: one chip and picture a pasted image not yet sent.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.surface !== "terminal") return next(e);
    await read($, draftsChanged);
    if (drafts.pictures.size === 0 || e.props.hasSurvey) {
      leave(e.requestId);

      return next(e);
    }
    const row = await next(e);

    return withChips(
      e,
      row,
      !e.props.isCollapsed,
      $.ui.resolve(e),
      (io, file, name, columns) =>
        openFile($, io, file, name, columns, oneAtATime, sized),
      (io) =>
        pastedChips(
          io,
          [...drafts.pictures].map(([number, path]) => ({ path, number })),
        ),
    );
  });
};

/** The pictures pasted into the prompt box and not yet sent. */
class Drafts {
  // Claude Code's number for each, to a copy of the clipboard taken at its
  // paste.
  readonly pictures = new Map<number, string>();
  // The numbers the box held when last seen: a number new to it was pasted.
  private held = new Set<number>();
  // Numbers pasted before session.start bound the host: copied once it has.
  private pending: number[] = [];

  /** Takes the box's text: the numbers new to it, and the copies it let go. */
  look(text: string) {
    const now = new Set(pastedImageNumbers(text));
    const fresh = [...now].filter((n) => !this.held.has(n) && !this.pictures.has(n));
    const gone: string[] = [];
    for (const [number, path] of this.pictures) {
      if (now.has(number)) continue;
      this.pictures.delete(number);
      gone.push(path);
    }
    this.held = now;

    return { fresh, gone };
  }

  /** Holds numbers pasted before the host was bound, for `takePending`. */
  defer(numbers: readonly number[]) {
    this.pending.push(...numbers);
  }

  /** The deferred numbers the box still holds; none are deferred after. */
  takePending() {
    const still = this.pending.filter((n) => this.held.has(n));
    this.pending = [];

    return still;
  }

  /** Keeps a copy taken for `number`, unless the box let it go meanwhile. */
  keep(number: number, path: string) {
    if (!this.held.has(number)) return false;
    this.pictures.set(number, path);

    return true;
  }
}

/**
 * Brings the band's pictures in line with the box's text: removes the copies
 * of images it no longer holds and, where the change was a paste, copies the
 * clipboard for each image new to it.
 */
async function syncDrafts(
  $: EngineInterface,
  drafts: Drafts,
  io: Host | undefined,
  text: string,
  isPaste: boolean,
) {
  const { fresh, gone } = drafts.look(text);
  for (const path of gone) io?.remove(path);
  let isChanged = gone.length > 0;
  if (isPaste && fresh.length > 0) {
    if (io === undefined) {
      // Pasted while the session was still starting: copied at its end.
      drafts.defer(fresh);
      $.ui.log(
        `imgview: [Image #${fresh.join("], [Image #")}] pasted before imgview was ready; its preview waits for session start`,
        { to: "debug" },
      );
    } else if (await captureDrafts($, drafts, io, fresh)) isChanged = true;
  }
  if (isChanged) await update($, draftsChanged, (count) => count + 1);
}

/**
 * Copies the clipboard once for each pasted image number, and keeps the
 * copies the box still holds. True when one was kept. A failure is logged,
 * and shown in a toast unless the clipboard simply held no PNG.
 */
async function captureDrafts(
  $: EngineInterface,
  drafts: Drafts,
  io: Host,
  numbers: readonly number[],
) {
  let isKept = false;
  for (const number of numbers) {
    const path = io.tempPath("png");
    io.keep(path);
    try {
      await captureClipboard($, path);
    } catch (error) {
      io.remove(path);
      const reason = error instanceof Error ? error.message : String(error);
      const line = `imgview: no preview for pasted [Image #${number}]: ${reason}`;
      $.ui.log(line, { to: "debug" });
      // A file's path pasted as text is no fault of the setup.
      if (reason !== CLIPBOARD_EXIT[5]) $.ui.toast(line);
      continue;
    }
    if (drafts.keep(number, path)) isKept = true;
    else io.remove(path);
  }

  return isKept;
}

/** Copies the images pasted before the host was bound, now that it is. */
async function captureDeferred($: EngineInterface, drafts: Drafts, io: Host) {
  const numbers = drafts.takePending();
  if (numbers.length === 0) return;
  if (await captureDrafts($, drafts, io, numbers))
    await update($, draftsChanged, (count) => count + 1);
}

/** One chip a pasted picture that is still there, named by its number. */
async function pastedChips(
  io: Host,
  pictures: readonly { path: string; number: number }[],
): Promise<Chip[]> {
  const chips: Chip[] = [];
  for (const { path, number } of pictures) {
    const found = await io.stat(path);
    if (found?.kind !== "file") continue;
    const name = `Image #${number}`;
    chips.push({
      file: {
        path: found.realPath ?? path,
        mtimeMs: found.mtimeMs,
        ...(io.canPreview ? {} : { hasNoCard: true as const }),
      },
      label: `▣ ${name}`,
      name,
    });
  }

  return chips;
}
