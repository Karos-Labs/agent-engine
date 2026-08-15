import type { DurableStepStore, GateRecord, RunRecord, SlotRecord, StepRecord } from "./types.js";

function scopedKey(runId: string, id: string): string {
  return `${runId}::${id}`;
}

/**
 * In-memory `DurableStepStore` — fast, isolated, zero I/O, ideal for unit
 * tests (RFC-01 §8.4a's Firestore adapter is the production target; this is
 * the same "small internal interface, swap the adapter" principle applied to
 * local/test execution).
 *
 * Every getter returns the exact object last stored — callers must treat
 * returned records as read-only and always `saveX` a fresh object rather
 * than mutating one in place, the same discipline the Firestore adapter
 * requires (there, mutating a returned object does nothing at all).
 */
export class MemoryDurableStepStore implements DurableStepStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly steps = new Map<string, StepRecord>();
  private readonly slots = new Map<string, SlotRecord>();
  private readonly gates = new Map<string, GateRecord>();

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async createRunIfNotExists(run: RunRecord): Promise<RunRecord> {
    const existing = this.runs.get(run.runId);
    if (existing) {
      return existing;
    }
    this.runs.set(run.runId, run);
    return run;
  }

  async updateRun(runId: string, patch: Partial<Omit<RunRecord, "runId">>): Promise<void> {
    const existing = this.runs.get(runId);
    if (!existing) {
      throw new Error(`MemoryDurableStepStore.updateRun: no run found for "${runId}"`);
    }
    this.runs.set(runId, { ...existing, ...patch });
  }

  async getStep(runId: string, stepId: string): Promise<StepRecord | undefined> {
    return this.steps.get(scopedKey(runId, stepId));
  }

  async saveStep(runId: string, step: StepRecord): Promise<void> {
    this.steps.set(scopedKey(runId, step.stepId), step);
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const prefix = `${runId}::`;
    const result: StepRecord[] = [];
    for (const [key, value] of this.steps) {
      if (key.startsWith(prefix)) {
        result.push(value);
      }
    }
    return result;
  }

  async getSlot(runId: string, slotId: string): Promise<SlotRecord | undefined> {
    return this.slots.get(scopedKey(runId, slotId));
  }

  async saveSlot(runId: string, slot: SlotRecord): Promise<void> {
    this.slots.set(scopedKey(runId, slot.slotId), slot);
  }

  async listSlots(runId: string, fanoutId: string): Promise<SlotRecord[]> {
    const prefix = `${runId}::`;
    const result: SlotRecord[] = [];
    for (const [key, value] of this.slots) {
      if (key.startsWith(prefix) && value.fanoutId === fanoutId) {
        result.push(value);
      }
    }
    return result;
  }

  async getGate(gateId: string): Promise<GateRecord | undefined> {
    return this.gates.get(gateId);
  }

  async saveGate(gate: GateRecord): Promise<void> {
    this.gates.set(gate.gateId, gate);
  }
}
