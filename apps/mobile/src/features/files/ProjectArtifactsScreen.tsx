import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  WS_METHODS,
  type ScopedProjectRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useUnadjustedBottomInset } from "../../components/ui/useBarInset";
import { connectionAtomRuntime } from "../../connection/runtime";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentScopeDenied } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { basename, fileRoutePathSegments } from "./filePath";

const listArtifacts = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:project-artifacts",
  tag: WS_METHODS.projectArtifactsSubscribe,
});
const removeArtifact = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "project-artifacts:remove",
  tag: WS_METHODS.projectArtifactsRemove,
});

export function ProjectArtifactsScreen({
  route,
}: StaticScreenProps<ScopedProjectRef & { readonly threadId: ThreadId }>) {
  const { environmentId, projectId, threadId } = route.params;
  const navigation = useNavigation();
  const gt = useGT();
  const bottomInset = useUnadjustedBottomInset();
  const project = useProject({ environmentId, projectId });
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const readDenied = useEnvironmentScopeDenied(environmentId, AuthFilesystemReadScope);
  const canRemove = useAtomValue(removeArtifact.permissionAtom(environmentId));
  const remove = useAtomCommand(removeArtifact);
  const list = useEnvironmentQuery(
    canRead ? listArtifacts({ environmentId, input: { projectId } }) : null,
  );

  return (
    <View className="flex-1">
      <AppBar
        title={gt("Artifacts")}
        subtitle={project?.title}
        onBack={() => navigation.goBack()}
      />
      <ScreenContent>
        <NativeScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: bottomInset + 12 }}
        >
          {readDenied || list.error !== null || list.data?.length === 0 ? (
            <AppText className="p-4 text-sm text-foreground-muted">
              {readDenied
                ? gt("File access is required.")
                : (list.error ?? gt("No saved artifacts."))}
            </AppText>
          ) : list.data === null || project === null ? (
            <AppActivityIndicator className="my-8" />
          ) : (
            list.data.map((artifact) => {
              const title = artifact.label ?? basename(artifact.path);
              return (
                <View
                  key={artifact.id}
                  className="flex-row items-center border-b border-border-subtle"
                >
                  <RowPressable
                    accessibilityRole="button"
                    className="min-h-11 flex-1 flex-row items-center gap-3 px-3 py-2"
                    onPress={() =>
                      navigation.dispatch(
                        StackActions.push("ThreadFile", {
                          environmentId,
                          threadId,
                          cwd: project.workspaceRoot,
                          projectName: project.title,
                          path: fileRoutePathSegments(artifact.path),
                        }),
                      )
                    }
                  >
                    <SymbolView name="doc" size={18} tintColorClassName="foreground-muted" />
                    <View className="min-w-0 flex-1">
                      <AppText className="text-sm font-t3-medium" numberOfLines={1}>
                        {title}
                      </AppText>
                      <AppText
                        className="text-xs text-foreground-muted"
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {artifact.description ?? artifact.path}
                      </AppText>
                    </View>
                  </RowPressable>
                  {canRemove ? (
                    <RowPressable
                      accessibilityRole="button"
                      accessibilityLabel={gt("Remove artifact {name}", { name: title })}
                      className="size-11 items-center justify-center"
                      onPress={() =>
                        void remove({ environmentId, input: { projectId, id: artifact.id } })
                      }
                    >
                      <SymbolView name="trash" size={17} tintColorClassName="foreground-muted" />
                    </RowPressable>
                  ) : null}
                </View>
              );
            })
          )}
        </NativeScrollView>
      </ScreenContent>
    </View>
  );
}
