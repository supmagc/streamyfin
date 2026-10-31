import type { Api } from "@jellyfin/sdk";
import { SubtitleApiAxiosParamCreator } from "@jellyfin/sdk/lib/generated-client/api/subtitle-api";
import {
  ItemFields,
  type MediaSourceInfo,
  type MediaStream,
  type SubtitleDeliveryMethod,
} from "@jellyfin/sdk/lib/generated-client/models";
import { getLibraryApi } from "@jellyfin/sdk/lib/utils/api";
import { File, Paths } from "expo-file-system";
import {
  SUBTITLE_SYNC_BATCH_SIZE,
  SUBTITLE_SYNC_FOLLOW_UP_ATTEMPTS,
  SUBTITLE_SYNC_FOLLOW_UP_INTERVAL_MS,
} from "@/constants/Subtitles";
import {
  getJellyfinHeadersForUrl,
  optionsWithOptionalHeaders,
} from "@/utils/customHeaders";
import { getAuthHeaders } from "@/utils/jellyfin/jellyfin";
import {
  isSidecarKey,
  pairSidecars,
  sidecarKey,
} from "@/utils/jellyfin/serverSubtitles";
import {
  isBurnedInSubtitle,
  isImageBasedSubtitle,
} from "@/utils/jellyfin/subtitleUtils";
import { SUBTITLES_OFF } from "@/utils/subtitles/subtitleIndex";
import {
  getAllDownloadedItems,
  getDownloadedItemById,
  updateDownloadedItem,
} from "./database";
import { deleteDownloadSubtitleFile } from "./fileOperations";
import type { DownloadedItem } from "./types";
import { subtitleFileName } from "./utils";

const EXTERNAL_DELIVERY = "External" as SubtitleDeliveryMethod;

/** Where a subtitle file comes from, and with which headers. */
interface SubtitleSource {
  url: string;
  headers?: Record<string, string>;
}

/** The subtitle burned into a transcoded download's picture, when it has one. */
export const burnedInSubtitle = (
  downloaded: DownloadedItem,
): MediaStream | undefined =>
  downloaded.mediaSource.MediaStreams?.find(
    (s) => s.Type === "Subtitle" && isBurnedInSubtitle(s),
  );

/** The subtitle files a download has next to its video, the ones it can lose again. */
export const downloadSubtitleFiles = (
  downloaded: DownloadedItem,
): MediaStream[] =>
  (downloaded.mediaSource.MediaStreams ?? []).filter(
    (s) =>
      s.Type === "Subtitle" &&
      s.IsExternal &&
      s.DeliveryMethod === EXTERNAL_DELIVERY,
  );

export const isLocalSubtitle = (
  downloaded: DownloadedItem,
  stream: MediaStream,
): boolean =>
  stream.Index != null &&
  (downloaded.localSubtitleIndexes ?? []).includes(stream.Index);

/**
 * Writes a subtitle file next to the download and adds it to its tracks, after all the others:
 * the offline player finds a subtitle file by its name, then by its place among the files, so the
 * ones already there keep theirs. Undefined when the file could not be written.
 */
export async function addSubtitleToDownload(
  downloaded: DownloadedItem,
  stream: MediaStream,
  source: SubtitleSource,
  { local = false }: { local?: boolean } = {},
): Promise<DownloadedItem | undefined> {
  const streams = downloaded.mediaSource.MediaStreams ?? [];
  const index = Math.max(-1, ...streams.map((s) => s.Index ?? -1)) + 1;
  const added: MediaStream = {
    ...stream,
    Type: "Subtitle",
    Index: index,
    IsExternal: true,
    IsDefault: false,
    DeliveryMethod: EXTERNAL_DELIVERY,
    DeliveryUrl: undefined,
    IsExternalUrl: false,
  };
  const destination = new File(
    Paths.document,
    subtitleFileName(downloaded.item, added),
  );
  try {
    if (destination.exists) destination.delete();
    await File.downloadFileAsync(
      source.url,
      destination,
      optionsWithOptionalHeaders({}, source.headers),
    );
  } catch (error) {
    console.error("[SUBTITLES] Failed to add a subtitle to a download:", error);
    return undefined;
  }
  added.DeliveryUrl = destination.uri;
  return {
    ...downloaded,
    mediaSource: {
      ...downloaded.mediaSource,
      MediaStreams: [...streams, added],
    },
    localSubtitleIndexes: local
      ? [...(downloaded.localSubtitleIndexes ?? []), index]
      : downloaded.localSubtitleIndexes,
  };
}

/**
 * Takes a subtitle file out of a download. One the server has is remembered as removed, so that
 * syncing does not bring it back; `remember: false` is for one the server dropped itself.
 */
export function removeSubtitleFromDownload(
  downloaded: DownloadedItem,
  stream: MediaStream,
  { remember = true }: { remember?: boolean } = {},
): DownloadedItem {
  deleteDownloadSubtitleFile(downloaded, stream);
  const local = isLocalSubtitle(downloaded, stream);
  const removed = downloaded.removedServerSubtitles ?? [];
  return {
    ...downloaded,
    mediaSource: {
      ...downloaded.mediaSource,
      MediaStreams: downloaded.mediaSource.MediaStreams?.filter(
        (s) => s.Index !== stream.Index,
      ),
    },
    userData: {
      ...downloaded.userData,
      subtitleStreamIndex:
        downloaded.userData.subtitleStreamIndex === stream.Index
          ? SUBTITLES_OFF
          : downloaded.userData.subtitleStreamIndex,
    },
    localSubtitleIndexes: downloaded.localSubtitleIndexes?.filter(
      (i) => i !== stream.Index,
    ),
    removedServerSubtitles:
      remember && !local ? [...removed, sidecarKey(stream)] : removed,
  };
}

/** The address of one of the server's subtitle files, as a download fetches it. */
const serverSubtitleSource = async (
  api: Api,
  downloaded: DownloadedItem,
  stream: MediaStream,
): Promise<SubtitleSource | undefined> => {
  const itemId = downloaded.item.Id;
  const mediaSourceId = downloaded.mediaSource.Id;
  if (!itemId || !mediaSourceId || stream.Index == null) return undefined;
  const { url } = await SubtitleApiAxiosParamCreator(
    api.configuration,
  ).getSubtitle(itemId, mediaSourceId, stream.Index, stream.Codec || "srt");
  const absolute = `${api.basePath}${url}`;
  return {
    url: absolute,
    headers: {
      ...getJellyfinHeadersForUrl(absolute, api.basePath),
      ...getAuthHeaders(api),
    },
  };
};

/**
 * Brings a download's subtitle files in line with the server's list of the same version: the
 * files the server added since are fetched, the ones it deleted are removed. Files from
 * OpenSubtitles and the ones the user removed stay as they are. Returns the download to save.
 */
export async function syncDownloadSubtitles(
  api: Api,
  downloaded: DownloadedItem,
  server: MediaStream[],
): Promise<DownloadedItem> {
  // An image file next to the media is not downloaded with it either.
  const serverFiles = server.filter(
    (s) => s.Type === "Subtitle" && s.IsExternal && !isImageBasedSubtitle(s),
  );
  const ours = downloadSubtitleFiles(downloaded).filter(
    (s) => !isLocalSubtitle(downloaded, s),
  );
  const { onlyOurs, onlyTheirs } = pairSidecars(ours, serverFiles);
  const removed = downloaded.removedServerSubtitles ?? [];

  let next = downloaded;
  for (const stream of onlyOurs) {
    next = removeSubtitleFromDownload(next, stream, { remember: false });
  }
  for (const stream of onlyTheirs) {
    if (removed.some((key) => isSidecarKey(key, stream))) continue;
    const source = await serverSubtitleSource(api, next, stream);
    const added = source && (await addSubtitleToDownload(next, stream, source));
    if (added) next = added;
  }
  // A removal the server has made for everyone needs no remembering.
  const stillOnServer = removed.filter((key) =>
    serverFiles.some((s) => isSidecarKey(key, s)),
  );
  if (stillOnServer.length !== removed.length) {
    next = { ...next, removedServerSubtitles: stillOnServer };
  }
  return next;
}

/** Saves a download, unless it was deleted while its subtitles were being fetched. */
function saveDownload(downloaded: DownloadedItem): void {
  const itemId = downloaded.item.Id;
  if (!itemId || !getDownloadedItemById(itemId)) return;
  updateDownloadedItem(itemId, downloaded);
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Changes a download's subtitles, one change at a time, on the download as it is saved when the
 * change starts: two at once would both add the same file, or one would save over the other.
 * `change` returns the download to save, or undefined to leave it. True when it saved a change.
 */
export function changeDownloadSubtitles(
  itemId: string,
  change: (
    downloaded: DownloadedItem,
  ) => Promise<DownloadedItem | undefined> | DownloadedItem | undefined,
): Promise<boolean> {
  const run = queue.then(async () => {
    const downloaded = getDownloadedItemById(itemId);
    if (!downloaded) return false;
    const next = await change(downloaded);
    if (!next || next === downloaded) return false;
    saveDownload(next);
    return true;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Adds one of the server's subtitle files to a download, also one with a subtitle burned in:
 * the user asked for it, the sync never would. `stream` is as the item lists it now.
 */
export const addServerSubtitleToDownload = (
  api: Api,
  itemId: string,
  stream: MediaStream,
) =>
  changeDownloadSubtitles(itemId, async (downloaded) => {
    const source = await serverSubtitleSource(api, downloaded, stream);
    return source && addSubtitleToDownload(downloaded, stream, source);
  });

/**
 * The subtitle files a download gained since a player read `known`, and the one to show: the
 * server's `saved` file when given, else the newest. A download only adds after its other
 * tracks, so the ones the player has keep their Index.
 */
export function subtitlesAddedSince(
  known: MediaStream[] | null | undefined,
  downloaded: DownloadedItem,
  saved?: MediaStream,
): { added: MediaStream[]; selected?: MediaStream } {
  const knownIndexes = new Set((known ?? []).map((s) => s.Index));
  const added = downloadSubtitleFiles(downloaded).filter(
    (s) => !knownIndexes.has(s.Index),
  );
  const selected =
    (saved && pairSidecars([saved], added).pairs[0]?.[1]) ?? added.at(-1);
  return { added, selected };
}

/** The items' versions as the server lists them now, by item id; null when it could not be asked. */
const fetchItemSources = async (
  api: Api,
  itemIds: string[],
  userId?: string | null,
): Promise<Map<string, MediaSourceInfo[]> | null> => {
  try {
    const { data } = await getLibraryApi(api).getItems({
      ids: itemIds,
      userId: userId ?? undefined,
      fields: [ItemFields.MediaSources],
    });
    return new Map(
      (data.Items ?? []).map((item) => [
        item.Id ?? "",
        item.MediaSources ?? [],
      ]),
    );
  } catch {
    return null;
  }
};

const syncWithSources = (
  api: Api,
  itemId: string,
  sources: MediaSourceInfo[] | undefined,
) =>
  changeDownloadSubtitles(itemId, (downloaded) => {
    // Another subtitle would show on top of the one in the picture.
    if (burnedInSubtitle(downloaded)) return undefined;
    // An item or version the server no longer lists says nothing about what it deleted.
    const server = sources?.find(
      (s) => s.Id === downloaded.mediaSource.Id,
    )?.MediaStreams;
    if (!server) return undefined;
    return syncDownloadSubtitles(api, downloaded, server);
  });

/** Syncs one download's subtitles with the server. True when it changed. */
export async function syncDownloadedItemSubtitles(
  api: Api,
  itemId: string,
  userId?: string | null,
): Promise<boolean> {
  const downloaded = getDownloadedItemById(itemId);
  if (!downloaded || burnedInSubtitle(downloaded)) return false;
  const sources = await fetchItemSources(api, [itemId], userId);
  return sources ? syncWithSources(api, itemId, sources.get(itemId)) : false;
}

/**
 * Syncs one download until the sync changes it, for a subtitle the server saved but has not
 * listed yet. True when it changed before the attempts ran out.
 */
export async function syncDownloadedItemSubtitlesWhenSaved(
  api: Api,
  itemId: string,
  userId?: string | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < SUBTITLE_SYNC_FOLLOW_UP_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, SUBTITLE_SYNC_FOLLOW_UP_INTERVAL_MS),
      );
    }
    if (await syncDownloadedItemSubtitles(api, itemId, userId)) return true;
  }
  return false;
}

/** Syncs every download's subtitles, asking the server about them in batches. True when one changed. */
export async function syncAllDownloadSubtitles(
  api: Api,
  userId?: string | null,
): Promise<boolean> {
  const itemIds = getAllDownloadedItems()
    .filter((downloaded) => !burnedInSubtitle(downloaded))
    .map((downloaded) => downloaded.item.Id)
    .filter((id): id is string => !!id);
  let changed = false;
  for (let i = 0; i < itemIds.length; i += SUBTITLE_SYNC_BATCH_SIZE) {
    const batch = itemIds.slice(i, i + SUBTITLE_SYNC_BATCH_SIZE);
    const sources = await fetchItemSources(api, batch, userId);
    if (!sources) return changed;
    for (const itemId of batch) {
      if (await syncWithSources(api, itemId, sources.get(itemId))) {
        changed = true;
      }
    }
  }
  return changed;
}
