import type { Api } from "@jellyfin/sdk";
import type { MediaStream } from "@jellyfin/sdk/lib/generated-client/models";
import { DOCUMENTS, fakeFiles } from "@/test-utils/fileSystem";
import type { DownloadedItem } from "./types";

jest.mock(
  "expo-file-system",
  () => jest.requireActual("@/test-utils/fileSystem").fileSystemModule,
);
jest.mock("@/utils/customHeaders", () =>
  jest.requireActual("@/test-utils/customHeaders").customHeadersModule(),
);
const mockStore = new Map<string, DownloadedItem>();
jest.mock("./database", () => ({
  getAllDownloadedItems: () => [...mockStore.values()],
  getDownloadedItemById: (id: string) => mockStore.get(id),
  updateDownloadedItem: (id: string, item: DownloadedItem) =>
    mockStore.set(id, item),
}));
jest.mock("./pendingDownloads", () => ({ getPendingDownloads: () => [] }));
const mockGetItems = jest.fn();
jest.mock("@jellyfin/sdk/lib/utils/api", () => ({
  getLibraryApi: () => ({ getItems: mockGetItems }),
}));
jest.mock("@jellyfin/sdk/lib/generated-client/api/subtitle-api", () => ({
  SubtitleApiAxiosParamCreator: () => ({
    getSubtitle: async (
      item: string,
      source: string,
      index: number,
      format: string,
    ) => ({
      url: `/Videos/${item}/${source}/Subtitles/${index}/Stream.${format}`,
    }),
  }),
}));

import {
  SUBTITLE_SYNC_FOLLOW_UP_ATTEMPTS,
  SUBTITLE_SYNC_FOLLOW_UP_INTERVAL_MS,
} from "@/constants/Subtitles";
import {
  addSubtitleToDownload,
  changeDownloadSubtitles,
  removeSubtitleFromDownload,
  subtitlesAddedSince,
  syncAllDownloadSubtitles,
  syncDownloadedItemSubtitles,
  syncDownloadedItemSubtitlesWhenSaved,
} from "./subtitles";

const api = {
  basePath: "https://jellyfin.example",
  accessToken: "token",
  deviceInfo: { id: "device" },
  configuration: {},
} as unknown as Api;

// generateFilename turns this into "show_s01e01".
const episode = {
  Id: "item-1",
  Type: "Episode",
  SeriesName: "Show",
  ParentIndexNumber: 1,
  IndexNumber: 1,
} as const;

const fileOf = (index: number) =>
  `${DOCUMENTS}/show_s01e01_subtitle_${index}.subrip`;

// As playback info listed it when the episode was downloaded: no path on the file next to it.
const dutchFile: MediaStream = {
  Index: 0,
  Type: "Subtitle",
  Codec: "subrip",
  Language: "dut",
  IsExternal: true,
  DeliveryMethod: "External",
  DeliveryUrl: fileOf(0),
};
const download = (overrides: Partial<DownloadedItem> = {}): DownloadedItem =>
  ({
    item: episode,
    mediaSource: {
      Id: "source-1",
      MediaStreams: [
        dutchFile,
        { Index: 1, Type: "Video" },
        { Index: 2, Type: "Audio" },
        {
          Index: 3,
          Type: "Subtitle",
          Language: "eng",
          DeliveryMethod: "Embed",
        },
      ],
    },
    videoFilePath: `${DOCUMENTS}/show_s01e01.mp4`,
    videoFileSize: 0,
    userData: {
      subtitleStreamIndex: 0,
      audioStreamIndex: 2,
      isTranscoded: false,
    },
    ...overrides,
  }) as DownloadedItem;

// The item as the server lists it now, an English file saved next to it since.
const serverFile = (
  index: number,
  language: string,
  path: string,
): MediaStream => ({
  Index: index,
  Type: "Subtitle",
  Codec: "subrip",
  Language: language,
  IsExternal: true,
  IsTextSubtitleStream: true,
  Path: path,
});
const englishOnServer = serverFile(0, "eng", "/media/show.en.srt");
const dutchOnServer = serverFile(1, "dut", "/media/show.nl.srt");
const serverLists = (...files: object[]) => ({
  data: {
    Items: [
      {
        Id: "item-1",
        MediaSources: [
          {
            Id: "source-1",
            MediaStreams: [...files, { Index: files.length, Type: "Video" }],
          },
        ],
      },
    ],
  },
});

const store = (downloaded: DownloadedItem) =>
  mockStore.set("item-1", downloaded);
const stored = () => mockStore.get("item-1") as DownloadedItem;
const sync = () => syncDownloadedItemSubtitles(api, "item-1", "user-1");
const subtitles = () =>
  stored().mediaSource.MediaStreams?.filter((s) => s.Type === "Subtitle");

beforeEach(() => {
  mockStore.clear();
  mockGetItems.mockReset();
  fakeFiles.clear();
  fakeFiles.add(fileOf(0));
});

describe("syncing a download's subtitles with the server", () => {
  test("fetches a file the server added, after the download's own tracks", async () => {
    store(download());
    mockGetItems.mockResolvedValue(serverLists(englishOnServer, dutchOnServer));

    await sync();

    expect(fakeFiles.downloads()).toEqual([
      {
        url: "https://jellyfin.example/Videos/item-1/source-1/Subtitles/0/Stream.subrip",
        destination: fileOf(4),
      },
    ]);
    expect(subtitles()?.map((s) => [s.Index, s.Language])).toEqual([
      [0, "dut"],
      [3, "eng"],
      [4, "eng"],
    ]);
    expect(subtitles()?.[2]).toMatchObject({
      DeliveryMethod: "External",
      DeliveryUrl: fileOf(4),
      Path: "/media/show.en.srt",
    });
  });

  // Playback info gave the Dutch file no path; the item does. Told apart by path alone, it
  // would be fetched a second time and the first copy removed.
  test("knows a file it has although only the server lists its path", async () => {
    store(download());
    mockGetItems.mockResolvedValue(serverLists(dutchOnServer));

    await sync();

    expect(fakeFiles.downloads()).toEqual([]);
    expect(fakeFiles.deleted()).toEqual([]);
  });

  test("removes a file the server deleted, and its selection", async () => {
    store(download());
    mockGetItems.mockResolvedValue(serverLists());

    await sync();

    expect(fakeFiles.deleted()).toEqual([fileOf(0)]);
    expect(subtitles()?.map((s) => s.Index)).toEqual([3]);
    expect(stored().userData.subtitleStreamIndex).toBe(-1);
    // The server dropped it for everyone: nothing for the download to hold against it.
    expect(stored().removedServerSubtitles).toEqual([]);
  });

  test("does not bring back a file the user removed", async () => {
    store(removeSubtitleFromDownload(download(), dutchFile));
    mockGetItems.mockResolvedValue(serverLists(dutchOnServer));

    await sync();

    expect(fakeFiles.downloads()).toEqual([]);
    expect(stored().removedServerSubtitles).toHaveLength(1);
  });

  test("forgets a removal once the server deleted the file too", async () => {
    store(removeSubtitleFromDownload(download(), dutchFile));
    mockGetItems.mockResolvedValue(serverLists());

    await sync();

    expect(stored().removedServerSubtitles).toEqual([]);
  });

  test("leaves a file from OpenSubtitles alone", async () => {
    store(download({ localSubtitleIndexes: [0] }));
    mockGetItems.mockResolvedValue(serverLists());

    await sync();

    expect(fakeFiles.deleted()).toEqual([]);
    expect(subtitles()?.map((s) => s.Index)).toEqual([0, 3]);
  });

  // Another subtitle would show on top of the one in the picture.
  test("leaves a download with a subtitle burned in alone", async () => {
    store(
      download({
        mediaSource: {
          Id: "source-1",
          MediaStreams: [
            { Index: 3, Type: "Subtitle", DeliveryMethod: "Encode" },
          ],
        },
      }),
    );
    mockGetItems.mockResolvedValue(serverLists(englishOnServer));

    await sync();

    expect(mockGetItems).not.toHaveBeenCalled();
    expect(fakeFiles.downloads()).toEqual([]);
  });

  test("changes nothing when the server cannot be asked", async () => {
    const before = download();
    store(before);
    mockGetItems.mockRejectedValue(new Error("offline"));

    await expect(sync()).resolves.toBe(false);
    expect(stored()).toBe(before);
  });

  // Its files cannot be told from deleted ones by a list that does not have them.
  test("keeps the files of a version the server no longer lists", async () => {
    store(download());
    mockGetItems.mockResolvedValue({
      data: { Items: [{ Id: "item-1", MediaSources: [{ Id: "other" }] }] },
    });

    await expect(sync()).resolves.toBe(false);
    expect(fakeFiles.deleted()).toEqual([]);
  });

  test("asks about every download in one request when syncing them all", async () => {
    store(download());
    mockStore.set("item-2", {
      ...download(),
      item: { ...episode, Id: "item-2" },
    });
    mockGetItems.mockResolvedValue(serverLists(dutchOnServer));

    await syncAllDownloadSubtitles(api, "user-1");

    expect(mockGetItems).toHaveBeenCalledTimes(1);
    expect(mockGetItems.mock.calls[0][0].ids).toEqual(["item-1", "item-2"]);
  });

  test("fetches a new file once when two syncs overlap", async () => {
    store(download());
    mockGetItems.mockResolvedValue(serverLists(englishOnServer, dutchOnServer));

    await Promise.all([sync(), sync()]);

    expect(fakeFiles.downloads()).toHaveLength(1);
    expect(subtitles()).toHaveLength(3);
  });
});

// The server can take longer to list a saved subtitle than the sheet waits for it.
describe("syncing a download for a subtitle the server is still saving", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const follow = () =>
    syncDownloadedItemSubtitlesWhenSaved(api, "item-1", "user-1");

  test("syncs again until the server lists it", async () => {
    store(download());
    mockGetItems
      .mockResolvedValueOnce(serverLists(dutchOnServer))
      .mockResolvedValue(serverLists(englishOnServer, dutchOnServer));

    const followed = follow();
    await jest.advanceTimersByTimeAsync(SUBTITLE_SYNC_FOLLOW_UP_INTERVAL_MS);

    await expect(followed).resolves.toBe(true);
    expect(mockGetItems).toHaveBeenCalledTimes(2);
    expect(subtitles()).toHaveLength(3);
  });

  test("gives up when the server never lists it", async () => {
    store(download());
    mockGetItems.mockResolvedValue(serverLists(dutchOnServer));

    const followed = follow();
    await jest.advanceTimersByTimeAsync(
      SUBTITLE_SYNC_FOLLOW_UP_INTERVAL_MS * SUBTITLE_SYNC_FOLLOW_UP_ATTEMPTS,
    );

    await expect(followed).resolves.toBe(false);
    expect(mockGetItems).toHaveBeenCalledTimes(
      SUBTITLE_SYNC_FOLLOW_UP_ATTEMPTS,
    );
  });
});

// A player that started on the download only has the files it had then.
describe("the subtitle files a download gained while it plays", () => {
  const playing = download().mediaSource.MediaStreams;
  const english: MediaStream = {
    ...englishOnServer,
    Index: 4,
    Type: "Subtitle",
    DeliveryMethod: "External",
    DeliveryUrl: fileOf(4),
  };
  const french: MediaStream = {
    Index: 5,
    Type: "Subtitle",
    Codec: "srt",
    Language: "fre",
    IsExternal: true,
    DeliveryMethod: "External",
    DeliveryUrl: fileOf(5),
  };
  const now = download({
    mediaSource: {
      Id: "source-1",
      MediaStreams: [...(playing ?? []), english, french],
    },
  });

  test("come after what the player has, with the server's saved file selected", () => {
    expect(subtitlesAddedSince(playing, now, englishOnServer)).toEqual({
      added: [english, french],
      selected: english,
    });
  });

  test("select the newest when the server saved none", () => {
    expect(subtitlesAddedSince(playing, now).selected).toBe(french);
  });

  test("are none when the download has nothing new", () => {
    expect(subtitlesAddedSince(playing, download())).toEqual({
      added: [],
      selected: undefined,
    });
  });
});

describe("changing a download's subtitles by hand", () => {
  test("a file from OpenSubtitles goes after the others and is marked as local", async () => {
    store(download());

    await changeDownloadSubtitles("item-1", (downloaded) =>
      addSubtitleToDownload(
        downloaded,
        { Codec: "srt", Language: "dut", Title: "Show.S01E01.NL" },
        { url: "https://dl.opensubtitles.example/file" },
        { local: true },
      ),
    );

    expect(fakeFiles.downloads()).toEqual([
      {
        url: "https://dl.opensubtitles.example/file",
        destination: `${DOCUMENTS}/show_s01e01_subtitle_4.srt`,
      },
    ]);
    expect(stored().localSubtitleIndexes).toEqual([4]);
  });

  test("removing a server's file deletes it and remembers it", () => {
    const removed = removeSubtitleFromDownload(download(), dutchFile);

    expect(fakeFiles.deleted()).toEqual([fileOf(0)]);
    expect(removed.removedServerSubtitles).toHaveLength(1);
  });

  test("removing a file from OpenSubtitles leaves nothing to remember", () => {
    const removed = removeSubtitleFromDownload(
      download({ localSubtitleIndexes: [0] }),
      dutchFile,
    );

    expect(removed.removedServerSubtitles).toEqual([]);
    expect(removed.localSubtitleIndexes).toEqual([]);
  });
});
