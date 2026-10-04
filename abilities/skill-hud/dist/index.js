import { defineAbility } from "@pab/ability-sdk";

const ability = defineAbility({
  async activate(api) {
    let active = await api.storage.get("active", null);
    const setActive = async (next) => { active = next; await api.storage.set("active", active); await api.publishEvent("skill.hud.updated", active); return active; };
    api.registerPage({ id: "skill-hud.home", title: "Skill HUD", route: "/abilities/skill-hud", render: () => active });
    api.registerCard({ id: "skill-hud.active", title: "Active skill", render: () => active ?? { state: "idle" } });
    api.registerCommand({ id: "skill-hud.start", title: "Start skill", execute: async ({ skillId, title, steps = [] } = {}) => { if (!skillId) throw new Error("skillId is required."); const item = { skillId, title: title ?? skillId, steps, currentStep: 0, status: "running", startedAt: new Date().toISOString() }; await setActive(item); await api.publishEvent("skill.started", item); return item; } });
    api.registerCommand({ id: "skill-hud.stop", title: "Stop skill", execute: async ({ reason = "user" } = {}) => { if (!active) return null; const completed = { ...active, status: "stopped", stopReason: reason, stoppedAt: new Date().toISOString() }; await setActive(null); await api.publishEvent("skill.finished", completed); return completed; } });
    api.subscribeEvent("skill.step.completed", async (step) => { if (active && step?.skillId === active.skillId) await setActive({ ...active, currentStep: step.index ?? active.currentStep + 1, lastStep: step }); });
    api.subscribeEvent("skill.finished", async (skill) => { if (active?.skillId === skill?.skillId) await setActive(null); });
    return { getActive: () => active };
  },
  async deactivate(api) { await api.storage.delete("active"); api.log("info", "Skill HUD deactivated"); }
});

export const activate = ability;
export const deactivate = ability.deactivate;
export default ability;
