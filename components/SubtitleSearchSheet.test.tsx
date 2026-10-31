import type {
  MediaStream,
  UserDto,
} from "@jellyfin/sdk/lib/generated-client/models";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { createStore, Provider as JotaiProvider } from "jotai";
import { Alert, type AlertButton } from "react-native";
import type { SubtitleSearchResult } from "@/hooks/useRemoteSubtitles";
import type { DownloadedItem } from "@/providers/Downloads/types";
import { SubtitleSearchSheet } from "./SubtitleSearchSheet";

let mockUser: UserDto | null = null;
let mockSubtitleLanguage: string | undefined;
const mockSearch = jest.fn();
const mockDownloadAsync = jest.fn();
let mockSearchResults: SubtitleSearchResult[] | undefined;
const mockFetchServerStreams = jest.fn();
const mockDeleteServerSubtitle = jest.fn();
let mockDownloads: DownloadedItem[] = [];
const mockSyncSubtitles = jest.fn();
const mockSyncSubtitlesWhenSaved = jest.fn();
const mockTakeServerSubtitle = jest.fn();
const mockTriggerRefresh = jest.fn();
const mockAddServerSubtitleToDownload = jest.fn();
const mockChangeDownloadSubtitles = jest.fn();

jest.mock("@gorhom/bottom-sheet", () => {
  const { forwardRef, useImperativeHandle } = jest.requireActual("react");
  return {
    BottomSheetModal: forwardRef(
      (
        { children }: { children: React.ReactNode },
        ref: React.Ref<unknown>,
      ) => {
        useImperativeHandle(ref, () => ({ present() {}, dismiss() {} }));
        return children;
      },
    ),
    BottomSheetScrollView: ({ children }: { children: React.ReactNode }) =>
      children,
    BottomSheetBackdrop: () => null,
  };
});
jest.mock("@/providers/DownloadProvider", () => ({
  useDownload: () => ({
    downloadedItems: mockDownloads,
    syncSubtitles: mockSyncSubtitles,
    syncSubtitlesWhenSaved: mockSyncSubtitlesWhenSaved,
    takeServerSubtitle: mockTakeServerSubtitle,
    triggerRefresh: mockTriggerRefresh,
  }),
}));
// What the sheet reads off a download is real; what changes one is recorded.
jest.mock("@/providers/Downloads/subtitles", () => {
  const { isBurnedInSubtitle } = jest.requireActual(
    "@/utils/jellyfin/subtitleUtils",
  );
  return {
    burnedInSubtitle: (d: DownloadedItem) =>
      d.mediaSource.MediaStreams?.find(isBurnedInSubtitle),
    downloadSubtitleFiles: (d: DownloadedItem) =>
      d.mediaSource.MediaStreams?.filter(
        (s) => s.Type === "Subtitle" && s.IsExternal,
      ) ?? [],
    isLocalSubtitle: (d: DownloadedItem, s: MediaStream) =>
      (d.localSubtitleIndexes ?? []).includes(s.Index ?? -1),
    addServerSubtitleToDownload: (...args: unknown[]) =>
      mockAddServerSubtitleToDownload(...args),
    changeDownloadSubtitles: (...args: unknown[]) =>
      mockChangeDownloadSubtitles(...args),
    removeSubtitleFromDownload: jest.fn(),
  };
});
// The language menu needs the app's modal host; only its trigger matters here.
jest.mock("./PlatformDropdown", () => ({
  PlatformDropdown: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("@/providers/JellyfinProvider", () => {
  const { atom } = jest.requireActual("jotai");
  return {
    apiAtom: atom({ basePath: "http://server" }),
    userAtom: atom(() => mockUser),
  };
});
jest.mock("@/utils/atoms/settings", () => ({
  useSettings: () => ({
    settings: {
      defaultSubtitleLanguage: mockSubtitleLanguage
        ? { ThreeLetterISOLanguageName: mockSubtitleLanguage }
        : null,
    },
  }),
}));
jest.mock("@/hooks/useRemoteSubtitles", () => ({
  useRemoteSubtitles: () => ({
    isSearching: false,
    searchError: null,
    searchResults: mockSearchResults,
    search: mockSearch,
    downloadAsync: mockDownloadAsync,
  }),
}));
jest.mock("@/utils/jellyfin/serverSubtitles", () => ({
  ...jest.requireActual("@/utils/jellyfin/serverSubtitles"),
  fetchServerStreams: (...args: unknown[]) => mockFetchServerStreams(...args),
  deleteServerSubtitle: (...args: unknown[]) =>
    mockDeleteServerSubtitle(...args),
}));

const found: SubtitleSearchResult = {
  id: "remote-1",
  name: "Some.Movie.1999.German",
  providerName: "Open Subtitles",
  format: "srt",
  language: "ger",
  source: "jellyfin",
};
const saved: MediaStream = {
  Index: 0,
  Type: "Subtitle",
  IsExternal: true,
  Language: "ger",
  Path: "/movies/movie.de.srt",
  DisplayTitle: "German - SRT",
};

const renderSheet = async ({ open = true }: { open?: boolean } = {}) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  const invalidate = jest.spyOn(client, "invalidateQueries");
  const onSaved = jest.fn();
  const setOpen = jest.fn();
  const store = createStore();
  const sheet = (isOpen: boolean) => (
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <SubtitleSearchSheet
          open={isOpen}
          setOpen={setOpen}
          item={{ Id: "item-1", Name: "Some Movie" }}
          mediaSourceId='source-1'
          onSaved={onSaved}
        />
      </JotaiProvider>
    </QueryClientProvider>
  );
  const { rerender } = await render(sheet(open));
  return {
    invalidate,
    onSaved,
    setOpen,
    reopen: () => rerender(sheet(true)),
  };
};

afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  mockUser = { Policy: { IsAdministrator: false } } as UserDto;
  mockSubtitleLanguage = "deu";
  mockSearchResults = [found];
  mockSearch.mockReset();
  mockDownloadAsync.mockReset();
  mockFetchServerStreams.mockReset().mockResolvedValue([saved]);
  mockDeleteServerSubtitle.mockReset().mockResolvedValue(true);
  mockDownloads = [];
  mockSyncSubtitles.mockReset().mockResolvedValue(undefined);
  mockSyncSubtitlesWhenSaved.mockReset().mockResolvedValue(undefined);
  mockTakeServerSubtitle
    .mockReset()
    .mockImplementation(async (_id: string, stream?: object) => !!stream);
  mockTriggerRefresh.mockReset();
  mockAddServerSubtitleToDownload.mockReset().mockResolvedValue(true);
  mockChangeDownloadSubtitles.mockReset().mockResolvedValue(true);
});

// Outside a playback a file kept on the device would never be played, so only
// what the server can save is offered.
test("searches the server only, in the user's subtitle language", async () => {
  await renderSheet();

  expect(mockSearch).toHaveBeenCalledWith({
    language: "ger",
    serverOnly: true,
  });
});

// The page mounts the sheet closed, before the user's language may have come
// in from their Jellyfin profile or the plugin. It used to keep the language
// it saw then and open on English.
test("opens on the user's subtitle language as it is when it opens", async () => {
  mockSubtitleLanguage = undefined;
  const { reopen } = await renderSheet({ open: false });

  mockSubtitleLanguage = "nld";
  await reopen();

  expect(mockSearch).toHaveBeenCalledTimes(1);
  expect(mockSearch).toHaveBeenCalledWith({
    language: "dut",
    serverOnly: true,
  });
});

// Saving renumbers every track: the page takes the new one along with the
// reloaded item, so it has to know before the reload.
test("hands over a saved subtitle before the item reloads, then closes", async () => {
  mockDownloadAsync.mockResolvedValue({ type: "server", stream: saved });
  const { invalidate, onSaved, setOpen } = await renderSheet();

  fireEvent.press(screen.getByText(found.name));

  await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
  expect(onSaved).toHaveBeenCalledWith(saved);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["item", "item-1"] });
  expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(
    invalidate.mock.invocationCallOrder[0],
  );
});

test("stays open and says so when the server has not listed it yet", async () => {
  mockDownloadAsync.mockResolvedValue({ type: "server", stream: undefined });
  const { onSaved, setOpen } = await renderSheet();

  fireEvent.press(screen.getByText(found.name));

  expect(await screen.findByText("player.subtitle_saved_pending")).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
  expect(setOpen).not.toHaveBeenCalled();
});

describe("the server's subtitle files", () => {
  test("are not offered to a user who is not an administrator", async () => {
    await renderSheet();

    await act(async () => {});

    expect(screen.queryByText("player.subtitle_files")).toBeNull();
    expect(mockFetchServerStreams).not.toHaveBeenCalled();
  });

  test("can be deleted by an administrator, once confirmed", async () => {
    mockUser = { Policy: { IsAdministrator: true } } as UserDto;
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await renderSheet();

    fireEvent.press(await screen.findByLabelText("common.delete"));
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    expect(mockDeleteServerSubtitle).not.toHaveBeenCalled();

    // Settled inside act: the delete, the reload and the list asked again.
    buttons.find((b) => b.style === "destructive")?.onPress?.();

    // The list is asked for again once the file is gone.
    await waitFor(() =>
      expect(mockFetchServerStreams).toHaveBeenCalledTimes(2),
    );
    expect(mockDeleteServerSubtitle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ itemId: "item-1", stream: saved }),
    );
  });
});

describe("for a downloaded item", () => {
  const libraryFile: MediaStream = {
    Index: 0,
    Type: "Subtitle",
    IsExternal: true,
    DeliveryMethod: "External",
    DisplayTitle: "Dutch - SRT",
  };
  const localFile: MediaStream = {
    Index: 4,
    Type: "Subtitle",
    IsExternal: true,
    DeliveryMethod: "External",
    DisplayTitle: "Dutch - OpenSubtitles",
  };
  const downloadOf = (
    streams: MediaStream[],
    overrides: Partial<DownloadedItem> = {},
  ) =>
    ({
      item: { Id: "item-1" },
      mediaSource: { Id: "source-1", MediaStreams: streams },
      userData: {},
      ...overrides,
    }) as DownloadedItem;

  /** The choices offered for the download's file at `position` in the list. */
  const alertButtons = async (position = 0) => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    fireEvent.press(
      (await screen.findAllByLabelText("common.delete"))[position],
    );
    return (alert.mock.calls.at(-1)?.[2] ?? []).map((b) => b.text);
  };

  // When the server cannot save one, a file kept with the download still plays.
  test("searches OpenSubtitles too", async () => {
    mockDownloads = [downloadOf([libraryFile])];
    await renderSheet();

    expect(mockSearch).toHaveBeenCalledWith({
      language: "ger",
      serverOnly: false,
    });
  });

  test("takes a subtitle the server saved into the download, then closes", async () => {
    mockDownloads = [downloadOf([libraryFile])];
    mockDownloadAsync.mockResolvedValue({ type: "server", stream: saved });
    const { setOpen } = await renderSheet();

    fireEvent.press(screen.getByText(found.name));

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(mockTakeServerSubtitle).toHaveBeenCalledWith("item-1", saved);
  });

  // The server can take longer than the sheet waits; the download catches up on its own.
  test("keeps syncing the download when the server has not listed the subtitle yet", async () => {
    mockDownloads = [downloadOf([libraryFile])];
    mockDownloadAsync.mockResolvedValue({ type: "server", stream: undefined });
    await renderSheet();

    fireEvent.press(screen.getByText(found.name));

    expect(
      await screen.findByText("player.subtitle_saved_pending_download"),
    ).toBeTruthy();
    expect(mockTakeServerSubtitle).toHaveBeenCalledWith("item-1", undefined);
  });

  test("warns about a burned in subtitle, and adds the saved one anyway", async () => {
    mockDownloads = [
      downloadOf([{ Index: 3, Type: "Subtitle", DeliveryMethod: "Encode" }]),
    ];
    mockDownloadAsync.mockResolvedValue({ type: "server", stream: saved });
    await renderSheet();

    expect(screen.getByText("player.subtitle_burned_in_warning")).toBeTruthy();
    fireEvent.press(screen.getByText(found.name));

    await waitFor(() =>
      expect(mockTakeServerSubtitle).toHaveBeenCalledWith("item-1", saved),
    );
  });

  test("closes once an OpenSubtitles file is in the download", async () => {
    mockDownloads = [downloadOf([libraryFile])];
    mockDownloadAsync.mockResolvedValue({ type: "download" });
    const { setOpen } = await renderSheet();

    fireEvent.press(screen.getByText(found.name));

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(mockTriggerRefresh).toHaveBeenCalled();
  });

  test("lets anyone remove a file from the download, not from the library", async () => {
    mockDownloads = [downloadOf([libraryFile])];
    await renderSheet();

    expect(await alertButtons()).toEqual([
      "common.cancel",
      "player.remove_from_download",
    ]);
  });

  test("lets an administrator delete a library file from the library too", async () => {
    mockUser = { Policy: { IsAdministrator: true } } as UserDto;
    mockDownloads = [downloadOf([libraryFile])];
    await renderSheet();

    expect(await alertButtons()).toEqual([
      "common.cancel",
      "player.remove_from_download",
      "player.delete_from_library",
    ]);
  });

  test("only removes a file from OpenSubtitles, which the library never had", async () => {
    mockUser = { Policy: { IsAdministrator: true } } as UserDto;
    mockDownloads = [
      downloadOf([libraryFile, localFile], { localSubtitleIndexes: [4] }),
    ];
    await renderSheet();

    expect(await alertButtons(1)).toEqual([
      "common.cancel",
      "player.remove_from_download",
    ]);
  });
});
