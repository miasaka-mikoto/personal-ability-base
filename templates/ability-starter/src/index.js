import { defineAbility } from "@pab/ability-sdk";

export default defineAbility({
  activate(api) {
    api.registerCommand({
      id: "com.example.my-ability.hello",
      title: "Hello Ability",
      execute: () => api.showNotification({ title: "My Ability", body: "It works!", level: "success" })
    });
  },
  deactivate() {}
});
