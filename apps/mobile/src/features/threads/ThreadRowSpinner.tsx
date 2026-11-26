import { useState, useEffect } from "react";
import { Animated } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useReduceMotionEnabled } from "../../lib/appState";

export function ThreadRowSpinner(props: { readonly animate: boolean; readonly tint: string }) {
  const [angle] = useState(() => new Animated.Value(0));
  const reduceMotion = useReduceMotionEnabled();
  const animate = props.animate && !reduceMotion;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native animation runs only while the row is visible and motion is enabled
  useEffect(() => {
    if (!animate) return;
    angle.setValue(0);
    const spin = Animated.loop(
      Animated.timing(angle, {
        toValue: 1,
        duration: 1000,
        easing: (progress) => Math.floor(progress * 8) / 8,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    spin.start();
    return () => spin.stop();
  }, [angle, animate]);

  return (
    <Animated.View
      style={{
        transform: [
          { rotate: angle.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) },
        ],
      }}
    >
      <SymbolView name="arrow.clockwise" size={13} tintColorClassName={props.tint} />
    </Animated.View>
  );
}
