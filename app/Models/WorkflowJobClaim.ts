import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Durable ownership survives a job's lease being reassigned to another runner. */
export default defineModel({
  name: 'WorkflowJobClaim',
  table: 'workflow_job_claims',
  primaryKey: 'id',
  autoIncrement: true,
  indexes: [
    { name: 'workflow_job_claims_runner_job_index', columns: ['runner_id', 'workflow_job_id'] },
    { name: 'workflow_job_claims_repository_index', columns: ['repository_id'] },
  ],
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  belongsTo: [
    { model: 'Runner', foreignKey: 'runner_id', onDelete: 'cascade' },
    { model: 'WorkflowJob', foreignKey: 'workflow_job_id', onDelete: 'cascade' },
  ],
  attributes: {
    runner_id: { fillable: true, validation: { rule: schema.number().required() }, factory: () => null },
    workflow_job_id: { fillable: true, validation: { rule: schema.number().required() }, factory: () => null },
    repository_id: { fillable: true, validation: { rule: schema.number().required() }, factory: () => null },
  },
})
