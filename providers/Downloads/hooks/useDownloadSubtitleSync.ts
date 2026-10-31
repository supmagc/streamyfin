import type { MediaStream } from "@jellyfin/sdk/lib/generated-client/models";
import { useAtomValue } from "jotai";
import { useCallback, useEffect } from "react";
import { Platform } from "react-native";
import { useNetworkStatus } from "@/providers/NetworkStatusProvider";
import { useWebSocketContext } from "@/providers/WebSocketProvider";
import { apiAtom, userAtom } from "@/utils/atoms/api";
import { getDownloadedItemById } from "../database";
import {
  addServerSubtitleToDownload,
  burnedInSubtitle,
  syncAllDownloadSubtitles,
  syncDownloadedItemSubtitles,
  syncDownloadedItemSubtitlesWhenSaved,
} from "../subtitles";

/**
 * Keeps downloads' subtitle files in line with the server's: all of them whenever the server
 * becomes reachable, which covers the changes made while the app was closed or away, and the
 * ones the server reports changed while it is open.
 */
export function useDownloadSubtitleSync({
  onDataChange,
}: {
  onDataChange: () => void;
}) {
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { serverConnected } = useNetworkStatus();
  const { subscribe } = useWebSocketContext();
  const userId = user?.Id;

  useEffect(() => {
    if (Platform.isTV || !api || !serverConnected) return;
    void syncAllDownloadSubtitles(api, userId).then((changed) => {
      if (changed) onDataChange();
    });
  }, [api, userId, serverConnected, onDataChange]);

  const syncItems = useCallback(
    async (itemIds: string[]) => {
      if (!api) return;
      let changed = false;
      for (const itemId of itemIds) {
        if (await syncDownloadedItemSubtitles(api, itemId, userId)) {
          changed = true;
        }
      }
      if (changed) onDataChange();
    },
    [api, userId, onDataChange],
  );

  const syncWhenSaved = useCallback(
    async (itemId: string) => {
      if (!api) return;
      if (await syncDownloadedItemSubtitlesWhenSaved(api, itemId, userId)) {
        onDataChange();
      }
    },
    [api, userId, onDataChange],
  );

  /**
   * Takes a subtitle the server saved into the item's download. False when the server has not
   * listed it yet: the download is then synced until it does.
   */
  const takeServerSubtitle = useCallback(
    async (itemId: string, stream: MediaStream | undefined) => {
      const downloaded = getDownloadedItemById(itemId);
      if (!api || !downloaded) return false;
      // The sync leaves a download with a subtitle burned in alone.
      const burnedIn = !!burnedInSubtitle(downloaded);
      if (!stream) {
        if (!burnedIn) void syncWhenSaved(itemId);
        return false;
      }
      if (!burnedIn) {
        await syncItems([itemId]);
      } else if (await addServerSubtitleToDownload(api, itemId, stream)) {
        onDataChange();
      }
      return true;
    },
    [api, syncItems, syncWhenSaved, onDataChange],
  );

  // A subtitle saved or deleted elsewhere refreshes the item on the server.
  useEffect(() => {
    if (Platform.isTV) return;
    return subscribe("LibraryChanged", (data) => {
      const updated: unknown = data?.ItemsUpdated;
      const itemIds = (Array.isArray(updated) ? updated : []).filter(
        (id): id is string =>
          typeof id === "string" && !!getDownloadedItemById(id),
      );
      if (itemIds.length > 0) void syncItems(itemIds);
    });
  }, [subscribe, syncItems]);

  return { syncItems, syncWhenSaved, takeServerSubtitle };
}
