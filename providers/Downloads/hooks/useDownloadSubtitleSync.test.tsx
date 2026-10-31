import { act, renderHook } from "@testing-library/react-native";
import { createStore, Provider as JotaiProvider } from "jotai";
import { useDownloadSubtitleSync } from "./useDownloadSubtitleSync";

let mockServerConnected: boolean | null = true;
let mockLibraryChanged: ((data: unknown) => void) | undefined;
const mockSyncAll = jest.fn();
const mockSyncItem = jest.fn();
const mockSyncWhenSaved = jest.fn();
const mockAddServerSubtitle = jest.fn();
let mockBurnedIn = false;

jest.mock("@/utils/atoms/api", () => {
  const { atom } = jest.requireActual("jotai");
  return {
    apiAtom: atom({ basePath: "https://jellyfin.example" }),
    userAtom: atom({ Id: "user-1" }),
  };
});
jest.mock("@/providers/NetworkStatusProvider", () => ({
  useNetworkStatus: () => ({ serverConnected: mockServerConnected }),
}));
jest.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    subscribe: (type: string, handler: (data: unknown) => void) => {
      if (type === "LibraryChanged") mockLibraryChanged = handler;
      return () => {};
    },
  }),
}));
jest.mock("../database", () => ({
  getDownloadedItemById: (id: string) =>
    id === "downloaded" ? { item: { Id: id } } : undefined,
}));
jest.mock("../subtitles", () => ({
  syncAllDownloadSubtitles: (...args: unknown[]) => mockSyncAll(...args),
  syncDownloadedItemSubtitles: (...args: unknown[]) => mockSyncItem(...args),
  syncDownloadedItemSubtitlesWhenSaved: (...args: unknown[]) =>
    mockSyncWhenSaved(...args),
  addServerSubtitleToDownload: (...args: unknown[]) =>
    mockAddServerSubtitle(...args),
  burnedInSubtitle: () => (mockBurnedIn ? { Index: 9 } : undefined),
}));

const renderSync = async () => {
  const onDataChange = jest.fn();
  const store = createStore();
  const view = await renderHook(
    () => useDownloadSubtitleSync({ onDataChange }),
    {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <JotaiProvider store={store}>{children}</JotaiProvider>
      ),
    },
  );
  // The sync is not awaited by the hook.
  await act(async () => {});
  return { ...view, onDataChange };
};

beforeEach(() => {
  mockServerConnected = true;
  mockLibraryChanged = undefined;
  mockSyncAll.mockReset().mockResolvedValue(false);
  mockSyncItem.mockReset().mockResolvedValue(false);
  mockSyncWhenSaved.mockReset().mockResolvedValue(false);
  mockAddServerSubtitle.mockReset().mockResolvedValue(true);
  mockBurnedIn = false;
});

test("catches up on every download while the server is reachable", async () => {
  mockSyncAll.mockResolvedValue(true);
  const { onDataChange } = await renderSync();

  expect(mockSyncAll).toHaveBeenCalledWith(expect.anything(), "user-1");
  expect(onDataChange).toHaveBeenCalledTimes(1);
});

test("waits for the server before catching up", async () => {
  mockServerConnected = false;
  const { rerender } = await renderSync();
  expect(mockSyncAll).not.toHaveBeenCalled();

  mockServerConnected = true;
  await rerender({});
  await act(async () => {});

  expect(mockSyncAll).toHaveBeenCalledTimes(1);
});

// A subtitle saved or deleted on another device updates the item on the server.
test("syncs the downloaded items a library change lists, and only those", async () => {
  mockSyncItem.mockResolvedValue(true);
  const { onDataChange } = await renderSync();

  await act(async () => {
    mockLibraryChanged?.({ ItemsUpdated: ["streamed", "downloaded"] });
  });

  expect(mockSyncItem).toHaveBeenCalledTimes(1);
  expect(mockSyncItem).toHaveBeenCalledWith(
    expect.anything(),
    "downloaded",
    "user-1",
  );
  expect(onDataChange).toHaveBeenCalled();
});

test("follows a subtitle the server is still saving into the download", async () => {
  mockSyncWhenSaved.mockResolvedValue(true);
  const { result, onDataChange } = await renderSync();
  onDataChange.mockClear();

  await act(() => result.current.syncWhenSaved("downloaded"));

  expect(mockSyncWhenSaved).toHaveBeenCalledWith(
    expect.anything(),
    "downloaded",
    "user-1",
  );
  expect(onDataChange).toHaveBeenCalledTimes(1);
});

describe("taking a subtitle the server saved into the download", () => {
  const saved = {
    Index: 0,
    Type: "Subtitle",
    Path: "/movies/a.fr.srt",
  } as const;

  test("goes through the sync", async () => {
    const { result } = await renderSync();

    let taken: boolean | undefined;
    await act(async () => {
      taken = await result.current.takeServerSubtitle("downloaded", saved);
    });

    expect(taken).toBe(true);
    expect(mockSyncItem).toHaveBeenCalledWith(
      expect.anything(),
      "downloaded",
      "user-1",
    );
    expect(mockAddServerSubtitle).not.toHaveBeenCalled();
  });

  // The sync leaves such a download alone, so the one asked for is added by hand.
  test("is added by hand to a download with a subtitle burned in", async () => {
    mockBurnedIn = true;
    const { result, onDataChange } = await renderSync();
    onDataChange.mockClear();

    await act(() => result.current.takeServerSubtitle("downloaded", saved));

    expect(mockAddServerSubtitle).toHaveBeenCalledWith(
      expect.anything(),
      "downloaded",
      saved,
    );
    expect(mockSyncItem).not.toHaveBeenCalled();
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  test("is followed until the server lists it", async () => {
    const { result } = await renderSync();

    let taken: boolean | undefined;
    await act(async () => {
      taken = await result.current.takeServerSubtitle("downloaded", undefined);
    });

    expect(taken).toBe(false);
    expect(mockSyncWhenSaved).toHaveBeenCalledWith(
      expect.anything(),
      "downloaded",
      "user-1",
    );
  });
});
