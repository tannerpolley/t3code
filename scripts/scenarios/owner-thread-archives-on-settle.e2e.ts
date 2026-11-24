import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test("Settling an owner thread moves it to Archive", WEB, async ({ t3, app, screen }) => {
  await t3.project("demo");
  await t3.open();
  const composer = screen.getByRole("textbox");
  await composer.fill("Give me a short tour");
  await composer.press("Enter");
  await expect(screen.getByText("This turn is a replay.", { exact: false })).toBeVisible();
  await expect(screen.getByRole("button", "Stop generation")).toBeHidden();
  await composer.press("ControlOrMeta+Shift+s");
  await screen.getByRole("textbox", "Message New thread").waitFor();

  await t3.open("/settings/archived");
  const unarchive = screen.getByRole("button", /^Unarchive /);
  try {
    await expect(unarchive).toBeVisible();
  } finally {
    await app.screenshot("settled-thread-in-archive");
  }
  await unarchive.tap();
  await expect(unarchive).not.toBeVisible();
});
