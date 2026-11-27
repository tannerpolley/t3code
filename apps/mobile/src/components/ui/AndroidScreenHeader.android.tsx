import { AppActivityIndicator } from "./AppActivityIndicator";
import { Column, Text as NativeText, RNHostView } from "@expo/ui/jetpack-compose";
import { useGT } from "gt-react-native";
import { use, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { NativeAppBar } from "./NativeAppBar.android";
import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { AndroidAnchoredMenu } from "./AndroidAnchoredMenu.android";
import { splitAndroidHeaderActions } from "./headerMenu.android";
import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import { useToolbarLayout } from "./useToolbarLayout";
import { useControlTheme } from "./useControlTheme";
import { RoutedFormSheetContext } from "./RoutedFormSheetContext";

export interface AndroidHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly selected?: boolean;
  readonly subtitle?: string;
  readonly destructive?: boolean;
  readonly iconScale?: number;
  readonly overflowOnly?: boolean;
}

export function AndroidHeaderIconButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly iconScale?: number;
}) {
  const { iconSize, buttonSize } = useAndroidControlSizing();
  const { colors } = useControlTheme();
  return (
    <Pressable
      accessible
      importantForAccessibility="yes"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled), selected: props.selected }}
      android_ripple={{ color: colors["--color-subtle-strong"], borderless: true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="items-center justify-center"
      style={{ width: buttonSize, height: buttonSize }}
    >
      <SymbolView
        name={props.icon === "ellipsis" ? { ios: "ellipsis", android: "more_vert" } : props.icon}
        size={iconSize * (props.iconScale ?? 1)}
        tintColorClassName={props.disabled ? "accent-icon-subtle" : "accent-header-foreground"}
        type="monochrome"
      />
    </Pressable>
  );
}

export function AndroidScreenHeader(props: {
  readonly title: string;
  readonly titleContent?: ReactNode;
  readonly subtitle?: string | null;
  readonly actions?: ReadonlyArray<AndroidHeaderAction>;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onBack?: () => void;
  readonly embedded?: boolean;
  readonly hideBottomBorder?: boolean;
}) {
  const gt = useGT();
  const { colors } = useControlTheme();
  const titleTypography = useScaledTextRole("title");
  const subtitleTypography = useScaledTextRole("label");
  const inFormSheet = use(RoutedFormSheetContext);
  const { paddingTop, paddingBottom } = useToolbarLayout(props.embedded || inFormSheet);
  const [headerWidth, setHeaderWidth] = useState(0);
  const { visibleActions, overflowActions } = splitAndroidHeaderActions(
    props.actions ?? [],
    headerWidth >= 600,
  );

  return (
    <View
      onLayout={(event) => setHeaderWidth(event.nativeEvent.layout.width)}
      className="border-b border-header-border bg-header"
      style={{
        paddingTop,
        paddingBottom,
        borderBottomWidth: props.hideBottomBorder ? 0 : undefined,
      }}
    >
      {inFormSheet ? (
        <View
          pointerEvents="none"
          className="absolute top-1 h-1 w-8 self-center rounded-full bg-header-foreground/40"
        />
      ) : null}
      <NativeAppBar
        navigationIcon={
          props.onBack || props.leading ? (
            <View collapsable={false} className="flex-row items-center">
              {props.onBack ? (
                <AndroidHeaderIconButton
                  accessibilityLabel={gt("Navigate up")}
                  icon="arrow.left"
                  onPress={props.onBack}
                />
              ) : null}

              {props.leading}
            </View>
          ) : undefined
        }
        title={
          props.titleContent ? (
            <RNHostView matchContents={{ vertical: true }}>
              <View collapsable={false}>{props.titleContent}</View>
            </RNHostView>
          ) : !props.subtitle ? (
            <NativeText
              color={colors["--color-header-foreground"]}
              maxLines={1}
              overflow="ellipsis"
              style={titleTypography}
            >
              {props.title}
            </NativeText>
          ) : (
            <Column>
              <NativeText
                color={colors["--color-header-foreground"]}
                maxLines={1}
                overflow="ellipsis"
                style={titleTypography}
              >
                {props.title}
              </NativeText>
              {props.subtitle ? (
                <NativeText
                  color={colors["--color-foreground-muted"]}
                  maxLines={1}
                  overflow="ellipsis"
                  style={subtitleTypography}
                >
                  {props.subtitle}
                </NativeText>
              ) : null}
            </Column>
          )
        }
        actions={
          visibleActions.length > 0 || overflowActions.length > 0 || props.trailing ? (
            <View collapsable={false} className="flex-row items-center">
              {visibleActions.map((action) =>
                action.loading ? (
                  <View
                    key={action.accessibilityLabel}
                    accessibilityLabel={action.accessibilityLabel}
                    className="size-12 items-center justify-center"
                  >
                    <AppActivityIndicator colorClassName="accent-header-foreground" />
                  </View>
                ) : (
                  <AndroidHeaderIconButton
                    key={action.accessibilityLabel}
                    accessibilityLabel={action.accessibilityLabel}
                    disabled={action.disabled}
                    selected={action.selected}
                    icon={action.icon}
                    iconScale={action.iconScale}
                    onPress={action.onPress}
                  />
                ),
              )}
              {overflowActions.length > 0 ? (
                <AndroidAnchoredMenu
                  actions={overflowActions.map((action, index) => ({
                    id: String(index),
                    title: action.accessibilityLabel,
                    subtitle: action.subtitle,
                    state: action.selected ? "on" : undefined,
                    attributes: {
                      disabled: Boolean(action.disabled),
                      destructive: action.destructive,
                    },
                  }))}
                  onPressAction={({ nativeEvent }) =>
                    overflowActions[Number(nativeEvent.event)]?.onPress()
                  }
                >
                  {(open) => (
                    <AndroidHeaderIconButton
                      accessibilityLabel={gt("More actions")}
                      icon="ellipsis"
                      onPress={open}
                    />
                  )}
                </AndroidAnchoredMenu>
              ) : null}
              {props.trailing}
            </View>
          ) : undefined
        }
      />
    </View>
  );
}
