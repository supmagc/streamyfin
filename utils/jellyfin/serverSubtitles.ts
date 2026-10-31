import type { Api } from "@jellyfin/sdk";
import type { MediaStream } from "@jellyfin/sdk/lib/generated-client/models";
import { getLibraryApi, getSubtitleApi } from "@jellyfin/sdk/lib/utils/api";
import {
  SERVER_SUBTITLE_POLL_ATTEMPTS,
  SERVER_SUBTITLE_POLL_INTERVAL_MS,
} from "@/constants/Subtitles";

export interface ServerSubtitleTarget {
  itemId: string;
  userId?: string | null;
  mediaSourceId?: string | null;
}

/**
 * What a subtitle file is, for when one of two lists has no path for it: the item and playback
 * info do not always both carry one.
 */
const sidecarTraits = (stream: MediaStream): string =>
  [
    stream.Codec,
    stream.Language,
    stream.Title,
    stream.IsForced,
    stream.IsHearingImpaired,
  ].join("|");

/**
 * What tells a subtitle file next to the media apart from the others, to keep in storage. Never
 * its Index: the server puts these files before the file's own tracks and renumbers every track
 * from 0, so adding or removing one moves all the others.
 */
export const sidecarKey = (stream: MediaStream): string =>
  stream.Path ?? sidecarTraits(stream);

/** Whether a key kept by {@link sidecarKey} is this file's. */
export const isSidecarKey = (key: string, stream: MediaStream): boolean =>
  key === stream.Path || key === sidecarTraits(stream);

export const sidecarSubtitles = (streams: MediaStream[]): MediaStream[] =>
  streams.filter((s) => s.Type === "Subtitle" && s.IsExternal);

/**
 * Pairs the subtitle files of two lists of the same item: by path where both have one, then by
 * what they are. One at a time, as two files without a path can look alike.
 */
export const pairSidecars = (
  ours: MediaStream[],
  theirs: MediaStream[],
): {
  pairs: [MediaStream, MediaStream][];
  onlyOurs: MediaStream[];
  onlyTheirs: MediaStream[];
} => {
  const onlyOurs = sidecarSubtitles(ours);
  const onlyTheirs = sidecarSubtitles(theirs);
  const pairs: [MediaStream, MediaStream][] = [];
  const take = (same: (a: MediaStream, b: MediaStream) => boolean) => {
    for (const a of [...onlyOurs]) {
      const b = onlyTheirs.find((candidate) => same(a, candidate));
      if (!b) continue;
      pairs.push([a, b]);
      onlyOurs.splice(onlyOurs.indexOf(a), 1);
      onlyTheirs.splice(onlyTheirs.indexOf(b), 1);
    }
  };
  take((a, b) => !!a.Path && a.Path === b.Path);
  take((a, b) => !(a.Path && b.Path) && sidecarTraits(a) === sidecarTraits(b));
  return { pairs, onlyOurs, onlyTheirs };
};

/** The subtitle files in `after` that `before` did not have. */
export const addedSidecarSubtitles = (
  before: MediaStream[],
  after: MediaStream[],
): MediaStream[] => pairSidecars(before, after).onlyTheirs;

/** The item's streams as the server lists them now, or null when it could not be asked. */
export const fetchServerStreams = async (
  api: Api,
  { itemId, userId, mediaSourceId }: ServerSubtitleTarget,
): Promise<MediaStream[] | null> => {
  try {
    const { data } = await getLibraryApi(api).getItem({
      itemId,
      userId: userId ?? undefined,
    });
    const source =
      data.MediaSources?.find((s) => s.Id === mediaSourceId) ??
      data.MediaSources?.[0];
    return source?.MediaStreams ?? [];
  } catch {
    return null;
  }
};

/** Asks the server for the item's streams until `found` returns something, or gives up. */
const pollServerStreams = async <T>(
  api: Api,
  target: ServerSubtitleTarget,
  found: (streams: MediaStream[]) => T | undefined,
): Promise<T | undefined> => {
  for (let attempt = 0; attempt < SERVER_SUBTITLE_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, SERVER_SUBTITLE_POLL_INTERVAL_MS),
    );
    const streams = await fetchServerStreams(api, target);
    const result = streams ? found(streams) : undefined;
    if (result !== undefined) return result;
  }
  return undefined;
};

/**
 * Waits for the subtitle file the server is saving to show up, and returns it: the one in the
 * language asked for when several appeared. Undefined when it did not show up in time.
 */
export const waitForAddedServerSubtitle = (
  api: Api,
  target: ServerSubtitleTarget & { before: MediaStream[]; language?: string },
): Promise<MediaStream | undefined> =>
  pollServerStreams(api, target, (streams) => {
    const added = addedSidecarSubtitles(target.before, streams);
    if (added.length === 0) return undefined;
    return added.find((s) => s.Language === target.language) ?? added[0];
  });

/**
 * Deletes a subtitle file from the server and waits for it to be gone. The server deletes by
 * Index, so the file is looked up again first: a list shown a while ago can have been renumbered
 * since, and its Index would now be another file's. False when it stayed or was not found.
 */
export const deleteServerSubtitle = async (
  api: Api,
  target: ServerSubtitleTarget & { stream: MediaStream },
): Promise<boolean> => {
  const streams = await fetchServerStreams(api, target);
  const current = pairSidecars([target.stream], streams ?? []).pairs[0]?.[1];
  if (current?.Index == null) return false;
  await getSubtitleApi(api).deleteSubtitle({
    itemId: target.itemId,
    index: current.Index,
  });
  return waitForRemovedServerSubtitle(api, target);
};

/** Waits for a deleted subtitle file to be gone from the server's list. False when it stayed. */
export const waitForRemovedServerSubtitle = async (
  api: Api,
  target: ServerSubtitleTarget & { stream: MediaStream },
): Promise<boolean> => {
  const gone = await pollServerStreams(api, target, (streams) =>
    pairSidecars([target.stream], streams).pairs.length > 0 ? undefined : true,
  );
  return gone === true;
};
