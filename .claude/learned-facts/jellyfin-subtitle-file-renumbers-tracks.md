# A Subtitle File Saved Next to Media Renumbers Every Track

**Date**: 2026-10-31
**Category**: state-and-data
**Key files**: Jellyfin `MediaBrowser.Providers/MediaInfo/FFProbeVideoInfo.cs`, `utils/jellyfin/serverSubtitles.ts`

## Detail

Jellyfin lists subtitle files that sit next to the media before the file's own tracks, then sets every stream's `Index` to its place in that list (`currentStreams.InsertRange(0, externalSubtitleStreams)`, then `mediaStreams[i].Index = i`). Saving a subtitle through the remote search, or deleting one, therefore moves every other stream's `Index`, audio and video included.

An `Index` is only good for the item as the server lists it at that moment. Comparing indexes from before and after a save picks the wrong track: the player did, and selected a renumbered one. Tell subtitle files apart by `MediaStream.Path`, which the item gives, and by what they are (codec, language, title, forced, SDH) when one list lacks the path, as playback info can: `pairSidecars` does both. A delete goes by `Index`, so look the file up again right before it.

## Symptom pattern

After a subtitle is downloaded to the server, the app selects or reports a different subtitle, or an audio choice made before the save now points at another track.
