import type {
  BaseItemDto,
  MediaSourceInfo,
} from "@jellyfin/sdk/lib/generated-client";
import { render } from "@testing-library/react-native";
import { MediaSourceButton } from "./MediaSourceButton";
import type { OptionGroup } from "./PlatformDropdown";

let mockGroups: OptionGroup[] = [];

jest.mock("./PlatformDropdown", () => ({
  PlatformDropdown: ({ groups }: { groups: OptionGroup[] }) => {
    mockGroups = groups;
    return null;
  },
}));
jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("@/utils/atoms/settings", () => ({
  useSettings: () => ({ settings: {} }),
}));
jest.mock("@/utils/seriesTrackMemory", () => ({
  rememberSeriesTrackFromRow: jest.fn(),
}));

const source: MediaSourceInfo = {
  Id: "source-1",
  MediaStreams: [
    { Index: 0, Type: "Video" },
    { Index: 1, Type: "Audio", Language: "eng", DisplayTitle: "English" },
    { Index: 2, Type: "Audio", Language: "fre", DisplayTitle: "French" },
    {
      Index: 3,
      Type: "Subtitle",
      Language: "dut",
      DisplayTitle: "Dutch",
      IsExternal: true,
      DeliveryMethod: "External",
      DeliveryUrl: "file:///documents/movie_subtitle_3.srt",
    },
  ],
};
const item: BaseItemDto = { Id: "item-1", MediaSources: [source] };

const renderButton = (
  props: Partial<React.ComponentProps<typeof MediaSourceButton>> = {},
) =>
  render(
    <MediaSourceButton
      item={item}
      selectedOptions={{
        mediaSource: source,
        audioIndex: 1,
        subtitleIndex: 3,
        bitrate: { key: "Max", value: undefined },
      }}
      setSelectedOptions={jest.fn()}
      {...props}
    />,
  );

const titles = () => mockGroups.map((group) => group.title);
const labels = (title: string) =>
  mockGroups
    .find((group) => group.title === title)
    ?.options.map((option) => option.label);

test("offers a quality for a streamed item", async () => {
  await renderButton();

  expect(titles()).toContain("item_card.quality");
});

// A downloaded file has the one quality it was saved in.
test("offers a download's own tracks and the subtitle search, not a quality", async () => {
  await renderButton({
    download: { isTranscoded: false },
    onSearchSubtitles: jest.fn(),
  });

  expect(titles()).toEqual(["item_card.audio", "item_card.subtitles.label"]);
  expect(labels("item_card.audio")).toEqual(["English", "French"]);
  expect(labels("item_card.subtitles.label")).toEqual(
    expect.arrayContaining(["Dutch", "player.search_subtitles"]),
  );
});

test("offers only the audio track a transcoded download kept", async () => {
  await renderButton({ download: { isTranscoded: true } });

  expect(labels("item_card.audio")).toEqual(["English"]);
});
