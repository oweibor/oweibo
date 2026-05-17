// D.14 — Auto-escalation: checks grades and writes to oweibo.charter_spot_audit_queue.
// Triggers:
//   - Any red grade on any axis → immediate escalation
//   - Two consecutive yellow grades on the same axis (same task_id) → escalation

import type { Pool } from 'pg';

export interface GradeRecord {
  taskId:          string;
  reviewerId:      string;
  runMonth:        string;   // 'YYYY-MM'
  eleganceGrade:   'red' | 'yellow' | 'green';
  complexityGrade: 'red' | 'yellow' | 'green';
  initiativeGrade: 'red' | 'yellow' | 'green';
  notes?:          string;
}

export interface EscalationResult {
  escalated:      boolean;
  reasons:        string[];
}

/**
 * Persist a grade and check escalation rules.
 * Writes to oweibo.elegance_battery_results and, if triggered, to charter_spot_audit_queue.
 */
export async function recordGradeAndEscalate(
  pool:  Pool,
  grade: GradeRecord,
): Promise<EscalationResult> {
  // Persist the grade
  await pool.query(
    `INSERT INTO oweibo.elegance_battery_results
       (run_month, task_id, reviewer_id,
        elegance_grade, complexity_grade, initiative_grade, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      grade.runMonth,
      grade.taskId,
      grade.reviewerId,
      grade.eleganceGrade,
      grade.complexityGrade,
      grade.initiativeGrade,
      grade.notes ?? null,
    ],
  );

  const reasons: string[] = [];

  // Rule 1: any red grade → immediate escalation
  const axes: Array<{ axis: string; value: string }> = [
    { axis: 'elegance',   value: grade.eleganceGrade },
    { axis: 'complexity', value: grade.complexityGrade },
    { axis: 'initiative', value: grade.initiativeGrade },
  ];

  for (const { axis, value } of axes) {
    if (value === 'red') {
      reasons.push(`red grade on ${axis} for task ${grade.taskId} in ${grade.runMonth}`);
    }
  }

  // Rule 2: two consecutive yellow grades on the same axis/task
  if (reasons.length === 0) {
    const prevResult = await pool.query<{
      elegance_grade:   string;
      complexity_grade: string;
      initiative_grade: string;
      run_month:        string;
    }>(
      `SELECT elegance_grade, complexity_grade, initiative_grade, run_month
       FROM oweibo.elegance_battery_results
       WHERE task_id = $1
         AND run_month < $2
       ORDER BY run_month DESC
       LIMIT 1`,
      [grade.taskId, grade.runMonth],
    );

    if (prevResult.rows.length > 0) {
      const prev = prevResult.rows[0]!;
      const consecutiveChecks: Array<{ axis: string; curr: string; prior: string }> = [
        { axis: 'elegance',   curr: grade.eleganceGrade,   prior: prev.elegance_grade },
        { axis: 'complexity', curr: grade.complexityGrade, prior: prev.complexity_grade },
        { axis: 'initiative', curr: grade.initiativeGrade, prior: prev.initiative_grade },
      ];
      for (const { axis, curr, prior } of consecutiveChecks) {
        if (curr === 'yellow' && prior === 'yellow') {
          reasons.push(
            `two consecutive yellow grades on ${axis} for task ${grade.taskId} ` +
            `(${prev.run_month} and ${grade.runMonth})`,
          );
        }
      }
    }
  }

  if (reasons.length === 0) return { escalated: false, reasons: [] };

  // Write escalation to charter_spot_audit_queue
  await pool.query(
    `INSERT INTO oweibo.charter_spot_audit_queue (trigger_type, payload)
     VALUES ('elegance_red', $1)`,
    [JSON.stringify({ taskId: grade.taskId, runMonth: grade.runMonth, reasons, grade })],
  );

  return { escalated: true, reasons };
}

/**
 * Check escalation for an entire month's batch of grades (used at end of battery run).
 * Returns all escalation reasons without re-inserting grades.
 */
export async function auditMonthForEscalations(
  pool:     Pool,
  runMonth: string,
): Promise<EscalationResult> {
  const result = await pool.query<{
    task_id:          string;
    elegance_grade:   string;
    complexity_grade: string;
    initiative_grade: string;
  }>(
    `SELECT task_id, elegance_grade, complexity_grade, initiative_grade
     FROM oweibo.elegance_battery_results
     WHERE run_month = $1`,
    [runMonth],
  );

  const allReasons: string[] = [];

  for (const row of result.rows) {
    for (const { axis, value } of [
      { axis: 'elegance',   value: row.elegance_grade },
      { axis: 'complexity', value: row.complexity_grade },
      { axis: 'initiative', value: row.initiative_grade },
    ]) {
      if (value === 'red') {
        allReasons.push(`red grade on ${axis} for task ${row.task_id} in ${runMonth}`);
      }
    }
  }

  return { escalated: allReasons.length > 0, reasons: allReasons };
}
