import type { UserDto, UserPolicy } from "@jellyfin/sdk/lib/generated-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import { AxiosError, type AxiosResponse } from "axios";
import { createStore, Provider as JotaiProvider } from "jotai";
import {
  SERVER_SUBTITLE_POLL_ATTEMPTS,
  SERVER_SUBTITLE_POLL_INTERVAL_MS,
} from "@/constants/Subtitles";
import { CACHE, fakeFiles } from "@/test-utils/fileSystem";
import { stubReactNative } from "@/test-utils/reactNative";
import { isExpectedError } from "@/utils/errors";
import { SubtitleSearchNotAllowedError } from "@/utils/jellyfin/subtitleSearchAccess";
import {
  openSubtitlesFileIdOf,
  type SubtitleSearchResult,
  useRemoteSubtitles,
} from "./useRemoteSubtitles";

let mockUser: UserDto | null = null;
let mockOpenSubtitlesApiKey: string | undefined;
const mockSearchRemoteSubtitles = jest.fn();
const mockOpenSubtitlesSearch = jest.fn();
const mockOpenSubtitlesDownload = jest.fn();

jest.mock("@/providers/JellyfinProvider", () => {
  const { atom } = jest.requireActual("jotai");
  return {
    apiAtom: atom({ basePath: "http://server" }),
    userAtom: atom(() => mockUser),
  };
});
const mockDownloadRemoteSubtitles = jest.fn();
const mockGetItem = jest.fn();

jest.mock("@jellyfin/sdk/lib/utils/api", () => ({
  getSubtitleApi: () => ({
    searchRemoteSubtitles: mockSearchRemoteSubtitles,
    downloadRemoteSubtitles: mockDownloadRemoteSubtitles,
  }),
  getLibraryApi: () => ({ getItem: mockGetItem }),
}));
jest.mock("@/utils/atoms/settings", () => ({
  useSettings: () => ({
    settings: { openSubtitlesApiKey: mockOpenSubtitlesApiKey },
  }),
}));
const mockChangeDownloadSubtitles = jest.fn();
const mockAddSubtitleToDownload = jest.fn();
jest.mock("@/providers/Downloads/subtitles", () => ({
  changeDownloadSubtitles: (
    itemId: string,
    change: (downloaded: object) => unknown,
  ) => mockChangeDownloadSubtitles(itemId, change),
  addSubtitleToDownload: (...args: unknown[]) =>
    mockAddSubtitleToDownload(...args),
}));
jest.mock("@/utils/atoms/downloadedSubtitles", () => ({
  addDownloadedSubtitle: jest.fn(),
}));
jest.mock("@/utils/opensubtitles/api", () => ({
  ...jest.requireActual("@/utils/opensubtitles/api"),
  OpenSubtitlesApi: class {
    search = mockOpenSubtitlesSearch;
    download = mockOpenSubtitlesDownload;
  },
}));

// Only the two fields the rule reads; the server sends the whole policy.
const userWith = (policy: Partial<UserPolicy>): UserDto => ({
  Policy: policy as UserPolicy,
});
const withoutPermission = userWith({
  IsAdministrator: false,
  EnableSubtitleManagement: false,
});
const withPermission = userWith({
  IsAdministrator: false,
  EnableSubtitleManagement: true,
});

const forbidden = () =>
  new AxiosError(
    "Request failed with status code 403",
    AxiosError.ERR_BAD_REQUEST,
    undefined,
    {},
    { status: 403, headers: {}, data: "", config: {} } as AxiosResponse,
  );

const renderRemoteSubtitles = async (
  itemId = "item-1",
  { intoDownload = false }: { intoDownload?: boolean } = {},
) => {
  // No garbage collection timer nor retry: either keeps Jest from exiting.
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
      mutations: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  // A store per render: the user atom is read once per store.
  const store = createStore();
  const { result } = await renderHook(
    () => useRemoteSubtitles({ itemId, item: { Id: itemId }, intoDownload }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>
          <JotaiProvider store={store}>{children}</JotaiProvider>
        </QueryClientProvider>
      ),
    },
  );
  return result;
};

const search = async () => {
  const result = await renderRemoteSubtitles();
  // Settled inside act, so the mutation's state updates are flushed with it.
  let outcome: unknown;
  await act(async () => {
    outcome = await result.current
      .searchAsync({ language: "eng" })
      .catch((error: unknown) => ({ failure: error }));
    // React Query hands its state updates to a timer.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return outcome as SubtitleSearchResult[] | { failure: unknown };
};

describe("useRemoteSubtitles — who may search on the server", () => {
  beforeEach(() => {
    mockUser = null;
    mockOpenSubtitlesApiKey = undefined;
    mockSearchRemoteSubtitles.mockReset().mockResolvedValue({ data: [] });
    mockOpenSubtitlesSearch.mockReset().mockResolvedValue({ data: [] });
  });

  test("searches the server for a user who may", async () => {
    mockUser = withPermission;

    expect(await search()).toEqual([]);
    expect(mockSearchRemoteSubtitles).toHaveBeenCalledTimes(1);
  });

  // REACT-NATIVE-7M: the request went out, came back 403, was reported, and
  // the screen blamed a missing subtitle provider.
  test("does not ask the server for a user who may not, and says why", async () => {
    mockUser = withoutPermission;

    const { failure } = (await search()) as { failure: unknown };

    expect(failure).toBeInstanceOf(SubtitleSearchNotAllowedError);
    expect(isExpectedError(failure)).toBe(true);
    expect(mockSearchRemoteSubtitles).not.toHaveBeenCalled();
  });

  test("goes straight to the client-side lookup when there is one", async () => {
    mockUser = withoutPermission;
    mockOpenSubtitlesApiKey = "key";

    expect(await search()).toEqual([]);
    expect(mockSearchRemoteSubtitles).not.toHaveBeenCalled();
    expect(mockOpenSubtitlesSearch).toHaveBeenCalledTimes(1);
  });

  // The stored policy can be older than the one on the server.
  test("a 403 from the server is the same refusal", async () => {
    mockUser = withPermission;
    mockSearchRemoteSubtitles.mockRejectedValue(forbidden());

    const { failure } = (await search()) as { failure: unknown };

    expect(failure).toBeInstanceOf(SubtitleSearchNotAllowedError);
    expect(isExpectedError(failure)).toBe(true);
  });

  // The item page offers only what the server can save: a client-side file
  // found there would never be played.
  test("a server-only search does not fall back to the client-side lookup", async () => {
    mockUser = withPermission;
    mockOpenSubtitlesApiKey = "key";
    const result = await renderRemoteSubtitles();

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.searchAsync({
        language: "eng",
        serverOnly: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(outcome).toEqual([]);
    expect(mockOpenSubtitlesSearch).not.toHaveBeenCalled();
  });

  test("a server-only search says why a user who may not gets nothing", async () => {
    mockUser = withoutPermission;
    mockOpenSubtitlesApiKey = "key";
    const result = await renderRemoteSubtitles();

    let failure: unknown;
    await act(async () => {
      failure = await result.current
        .searchAsync({ language: "eng", serverOnly: true })
        .catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(failure).toBeInstanceOf(SubtitleSearchNotAllowedError);
    expect(mockSearchRemoteSubtitles).not.toHaveBeenCalled();
    expect(mockOpenSubtitlesSearch).not.toHaveBeenCalled();
  });

  test("any other server failure is passed on as it came", async () => {
    mockUser = withPermission;
    const boom = new Error("boom");
    mockSearchRemoteSubtitles.mockRejectedValue(boom);

    expect(await search()).toEqual({ failure: boom });
  });
});

describe("useRemoteSubtitles — saving to the server", () => {
  const found: SubtitleSearchResult = {
    id: "remote-1",
    name: "Some Movie",
    providerName: "Open Subtitles",
    format: "srt",
    language: "eng",
    source: "jellyfin",
  };
  const embedded = { Index: 0, Type: "Subtitle" as const, Language: "eng" };
  const saved = {
    Index: 0,
    Type: "Subtitle" as const,
    Language: "eng",
    IsExternal: true,
    Path: "/movies/movie.en.srt",
  };
  const lists = (...streams: object[]) => ({
    data: { MediaSources: [{ Id: "source-1", MediaStreams: streams }] },
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockUser = withPermission;
    mockDownloadRemoteSubtitles.mockReset().mockResolvedValue({});
    mockGetItem.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  // The player and the TV modal select what comes back, so it is the saved
  // file in the server's new numbering.
  test("returns the subtitle the server lists once it saved it", async () => {
    mockGetItem
      .mockResolvedValueOnce(lists(embedded))
      .mockResolvedValue(lists(saved, { ...embedded, Index: 1 }));
    const result = await renderRemoteSubtitles();

    let outcome: unknown;
    await act(async () => {
      const pending = result.current.downloadAsync(found, "source-1");
      await jest.advanceTimersByTimeAsync(SERVER_SUBTITLE_POLL_INTERVAL_MS);
      outcome = await pending;
    });

    expect(mockDownloadRemoteSubtitles).toHaveBeenCalledWith({
      itemId: "item-1",
      subtitleId: "remote-1",
    });
    expect(outcome).toEqual({ type: "server", stream: saved });
  });

  // The server answers a download that failed, at OpenSubtitles' daily limit say, as a saved one.
  describe("a subtitle the server never lists, for a downloaded item", () => {
    const fromPlugin = { ...found, id: "e02a34f5_srt-fre-1189827" };
    const save = async () => {
      mockGetItem.mockResolvedValue(lists(embedded));
      const result = await renderRemoteSubtitles("item-1", {
        intoDownload: true,
      });
      let outcome: unknown;
      await act(async () => {
        const pending = result.current.downloadAsync(fromPlugin, "source-1");
        await jest.advanceTimersByTimeAsync(
          SERVER_SUBTITLE_POLL_INTERVAL_MS * SERVER_SUBTITLE_POLL_ATTEMPTS,
        );
        outcome = await pending;
      });
      return outcome;
    };

    beforeEach(() => {
      mockOpenSubtitlesDownload
        .mockReset()
        .mockResolvedValue({ link: "https://dl.opensubtitles.example/file" });
      mockChangeDownloadSubtitles.mockReset().mockResolvedValue(true);
    });
    afterEach(() => {
      mockOpenSubtitlesApiKey = undefined;
    });

    test("comes from OpenSubtitles into the download instead", async () => {
      mockOpenSubtitlesApiKey = "key";

      expect(await save()).toEqual({ type: "download" });
      expect(mockOpenSubtitlesDownload).toHaveBeenCalledWith(1189827);
    });

    test("is left to the server without an OpenSubtitles key", async () => {
      expect(await save()).toEqual({ type: "server", stream: undefined });
      expect(mockOpenSubtitlesDownload).not.toHaveBeenCalled();
    });
  });
});

describe("openSubtitlesFileIdOf", () => {
  const result = (id: string, providerName = "Open Subtitles") =>
    ({ id, providerName }) as SubtitleSearchResult;

  test("reads the file the server's OpenSubtitles plugin found", () => {
    expect(openSubtitlesFileIdOf(result("e02a34f5_srt-fre-1189827"))).toBe(
      1189827,
    );
    expect(
      openSubtitlesFileIdOf(result("e02a34f5_srt-eng-42-sdh-forced")),
    ).toBe(42);
  });

  test("has none for another provider's result", () => {
    expect(
      openSubtitlesFileIdOf(result("e02a34f5_srt-fre-1189827", "Podnapisi")),
    ).toBeUndefined();
    expect(openSubtitlesFileIdOf(result("e02a34f5_12345"))).toBeUndefined();
  });
});

// The name comes out of the OpenSubtitles response and, on TV, the item id out of the Jellyfin
// one. Whatever already sits at the destination is deleted before the write, so a separator in
// either used to delete, then replace, a file outside the subtitle cache.
describe("useRemoteSubtitles — where an OpenSubtitles download is written", () => {
  const SUBTITLES = `${CACHE}/streamyfin-subtitles`;
  const link = "https://dl.opensubtitles.example/file";
  const found: SubtitleSearchResult = {
    id: "result-1",
    name: "Some Movie",
    providerName: "OpenSubtitles",
    format: "srt",
    language: "eng",
    fileId: 7,
    source: "opensubtitles",
  };

  const download = async (fileName: string | undefined, itemId?: string) => {
    mockOpenSubtitlesDownload.mockResolvedValue({ link, file_name: fileName });
    const result = await renderRemoteSubtitles(itemId);
    await act(async () => {
      await result.current.downloadAsync(found);
      // React Query hands its state updates to a timer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fakeFiles.downloads().map((written) => written.destination);
  };

  beforeEach(() => {
    stubReactNative({ isTV: false });
    mockOpenSubtitlesApiKey = "key";
    mockOpenSubtitlesDownload.mockReset();
    fakeFiles.clear();
  });

  test("keeps the name OpenSubtitles gave the file", async () => {
    expect(await download("Some.Movie.1999.1080p.en.srt")).toEqual([
      `${SUBTITLES}/Some.Movie.1999.1080p.en.srt`,
    ]);
  });

  test("names the file after the subtitle when the response has no name", async () => {
    expect(await download(undefined)).toEqual([`${SUBTITLES}/subtitle_7.srt`]);
  });

  test.each([
    [
      "a path to another file",
      "../../../documents/show_s01e01.mp4",
      "show_s01e01.mp4",
    ],
    ["a nested path", "sub/dir.srt", "dir.srt"],
    ["a backslash", "sub\\dir.srt", "dir.srt"],
    ["only a parent directory", "..", "subtitle_7.srt"],
    ["a trailing separator", "sub/", "subtitle_7.srt"],
  ])(
    "writes a plain file in the cache, given a name with %s",
    async (_label, fileName, name) => {
      expect(await download(fileName)).toEqual([`${SUBTITLES}/${name}`]);
    },
  );

  test("keeps the item id out of the path on TV", async () => {
    stubReactNative({ isTV: true });

    expect(await download("movie.srt", "../../documents/x")).toEqual([
      `${SUBTITLES}/______documents_x_movie.srt`,
    ]);
    expect(await download("movie.srt", "0a1b2c3d-4e5f")).toContain(
      `${SUBTITLES}/0a1b2c3d-4e5f_movie.srt`,
    );
  });
});

// A file kept in the cache is lost to a download: offline, only the download's own files play.
describe("useRemoteSubtitles — an OpenSubtitles file for a downloaded item", () => {
  const found: SubtitleSearchResult = {
    id: "result-1",
    name: "Show.S01E01.NL",
    providerName: "OpenSubtitles",
    format: "srt",
    language: "nl",
    fileId: 7,
    source: "opensubtitles",
  };

  beforeEach(() => {
    stubReactNative({ isTV: false });
    mockOpenSubtitlesApiKey = "key";
    mockOpenSubtitlesDownload
      .mockReset()
      .mockResolvedValue({ link: "https://dl.opensubtitles.example/file" });
    mockChangeDownloadSubtitles
      .mockReset()
      .mockImplementation(async (_id, change) => {
        await change({ item: { Id: "item-1" } });
        return true;
      });
    mockAddSubtitleToDownload.mockReset().mockResolvedValue({});
    fakeFiles.clear();
  });

  test("goes into the download as a local file, not into the cache", async () => {
    const result = await renderRemoteSubtitles("item-1", {
      intoDownload: true,
    });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.downloadAsync(found);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(outcome).toEqual({ type: "download" });
    expect(fakeFiles.downloads()).toEqual([]);
    expect(mockAddSubtitleToDownload).toHaveBeenCalledWith(
      { item: { Id: "item-1" } },
      expect.objectContaining({
        Codec: "srt",
        Language: "dut",
        DisplayTitle: "Dutch - OpenSubtitles",
      }),
      { url: "https://dl.opensubtitles.example/file" },
      { local: true },
    );
  });
});
