import type { Api } from "@jellyfin/sdk";
import type { MediaStream } from "@jellyfin/sdk/lib/generated-client/models";
import {
  SERVER_SUBTITLE_POLL_ATTEMPTS,
  SERVER_SUBTITLE_POLL_INTERVAL_MS,
} from "@/constants/Subtitles";
import {
  addedSidecarSubtitles,
  deleteServerSubtitle,
  waitForAddedServerSubtitle,
} from "./serverSubtitles";

const mockGetItem = jest.fn();
const mockDeleteSubtitle = jest.fn();
jest.mock("@jellyfin/sdk/lib/utils/api", () => ({
  getLibraryApi: () => ({ getItem: mockGetItem }),
  getSubtitleApi: () => ({ deleteSubtitle: mockDeleteSubtitle }),
}));

const api = {} as Api;

const sidecar = (
  index: number,
  language: string,
  path?: string,
): MediaStream => ({
  Index: index,
  Type: "Subtitle",
  IsExternal: true,
  Codec: "srt",
  Language: language,
  Path: path,
});

// What the server lists before and after saving an English file next to a movie that already
// had a Dutch one and an embedded English track: the files go first and everything is renumbered.
const before: MediaStream[] = [
  sidecar(0, "dut", "/movies/movie.nl.srt"),
  { Index: 1, Type: "Video" },
  { Index: 2, Type: "Audio" },
  { Index: 3, Type: "Subtitle", Language: "eng", IsExternal: false },
];
const english = sidecar(0, "eng", "/movies/movie.en.srt");
const after: MediaStream[] = [
  english,
  sidecar(1, "dut", "/movies/movie.nl.srt"),
  { Index: 2, Type: "Video" },
  { Index: 3, Type: "Audio" },
  { Index: 4, Type: "Subtitle", Language: "eng", IsExternal: false },
];

const serverLists = (streams: MediaStream[]) => ({
  data: { MediaSources: [{ Id: "source-1", MediaStreams: streams }] },
});

describe("addedSidecarSubtitles", () => {
  // The player used to compare Index values: the renumbered Dutch file and the embedded track
  // both looked new, and the embedded one was picked for being English.
  test("finds the new file although the server renumbered every track", () => {
    expect(addedSidecarSubtitles(before, after)).toEqual([english]);
  });

  test("tells files apart by what they are when the server sends no path", () => {
    const withoutPaths = (streams: MediaStream[]) =>
      streams.map((s) => ({ ...s, Path: undefined }));

    expect(
      addedSidecarSubtitles(withoutPaths(before), withoutPaths(after)),
    ).toEqual([{ ...english, Path: undefined }]);
  });

  // Two English files of one format, told apart by their paths: neither is new.
  test("lets paths decide when both lists have them", () => {
    const first = sidecar(0, "eng", "/movies/movie.en.srt");
    const second = sidecar(1, "eng", "/movies/movie.en.forced.srt");

    expect(addedSidecarSubtitles([first], [first, second])).toEqual([second]);
    expect(addedSidecarSubtitles([second], [first])).toEqual([first]);
  });

  test("counts a second file that looks like the first one", () => {
    const one = [sidecar(0, "eng")];
    const two = [sidecar(0, "eng"), sidecar(1, "eng")];

    expect(addedSidecarSubtitles(one, two)).toHaveLength(1);
  });
});

describe("waitForAddedServerSubtitle", () => {
  const wait = (language = "eng") => {
    const found = waitForAddedServerSubtitle(api, {
      itemId: "item-1",
      mediaSourceId: "source-1",
      before,
      language,
    });
    return {
      found,
      tick: () =>
        jest.advanceTimersByTimeAsync(SERVER_SUBTITLE_POLL_INTERVAL_MS),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetItem.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  test("returns the file once the server lists it", async () => {
    mockGetItem
      .mockResolvedValueOnce(serverLists(before))
      .mockResolvedValue(serverLists(after));
    const { found, tick } = wait();

    await tick();
    await tick();

    await expect(found).resolves.toEqual(english);
    expect(mockGetItem).toHaveBeenCalledTimes(2);
  });

  test("asks again after a failed request", async () => {
    mockGetItem
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(serverLists(after));
    const { found, tick } = wait();

    await tick();
    await tick();

    await expect(found).resolves.toEqual(english);
  });

  test("gives up when the file never shows up", async () => {
    mockGetItem.mockResolvedValue(serverLists(before));
    const { found } = wait();

    await jest.advanceTimersByTimeAsync(
      SERVER_SUBTITLE_POLL_INTERVAL_MS * SERVER_SUBTITLE_POLL_ATTEMPTS,
    );

    await expect(found).resolves.toBeUndefined();
    expect(mockGetItem).toHaveBeenCalledTimes(SERVER_SUBTITLE_POLL_ATTEMPTS);
  });

  test("prefers the file in the language asked for", async () => {
    const french = sidecar(0, "fre", "/movies/movie.fr.srt");
    mockGetItem.mockResolvedValue(
      serverLists([french, { ...english, Index: 1 }, ...after.slice(1)]),
    );
    const { found, tick } = wait("eng");

    await tick();

    await expect(found).resolves.toEqual({ ...english, Index: 1 });
  });
});

describe("deleteServerSubtitle", () => {
  const remove = (stream: MediaStream) =>
    deleteServerSubtitle(api, {
      itemId: "item-1",
      mediaSourceId: "source-1",
      stream,
    });

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetItem.mockReset();
    mockDeleteSubtitle.mockReset().mockResolvedValue({});
  });
  afterEach(() => jest.useRealTimers());

  // The server deletes by Index. The Dutch file was listed as 0 before the English one was saved,
  // and is 1 now: deleting 0 would have removed the English file.
  test("deletes the file by the number the server gives it now", async () => {
    mockGetItem
      .mockResolvedValueOnce(serverLists(after))
      .mockResolvedValue(serverLists([english, ...after.slice(2)]));
    const deleted = remove(before[0]);

    await jest.advanceTimersByTimeAsync(SERVER_SUBTITLE_POLL_INTERVAL_MS);

    await expect(deleted).resolves.toBe(true);
    expect(mockDeleteSubtitle).toHaveBeenCalledWith({
      itemId: "item-1",
      index: 1,
    });
  });

  test("deletes nothing when the file is no longer listed", async () => {
    mockGetItem.mockResolvedValue(serverLists([english, ...after.slice(2)]));

    await expect(remove(before[0])).resolves.toBe(false);
    expect(mockDeleteSubtitle).not.toHaveBeenCalled();
  });

  test("reports a file the server still lists after deleting it", async () => {
    mockGetItem.mockResolvedValue(serverLists(after));
    const deleted = remove(before[0]);

    await jest.advanceTimersByTimeAsync(
      SERVER_SUBTITLE_POLL_INTERVAL_MS * SERVER_SUBTITLE_POLL_ATTEMPTS,
    );

    await expect(deleted).resolves.toBe(false);
  });
});
