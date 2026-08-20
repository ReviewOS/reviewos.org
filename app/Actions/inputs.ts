import { schema } from '@stacksjs/validation'

/**
 * A field whose type the endpoint does not care about, because it coerces it.
 *
 * **An action's `validations` block is enforced, not descriptive.** The
 * framework checks every declared rule before the handler runs and answers 422
 * with its own message, so a rule is a promise about what the endpoint accepts
 * rather than a note about what it expects.
 *
 * That is where forty fields across thirty actions went wrong. Each declared
 * `schema.string()` for a value its handler immediately passes through
 * `Number(...)` or a truthiness helper - `organization_id`, `comment_id`,
 * `team_id`, `required_approvals`, `is_draft`, `allow_squash_merge` - because a
 * browser form sends every field as a string and that is how these endpoints
 * are used from the interface. A JSON client sending the obvious
 * `{"organization_id": 41}` was refused with `Organization id Must be a string`
 * before any of that code ran.
 *
 * Nothing reported it, because the half of the API that is exercised by hand is
 * the half that speaks form encoding. The end-to-end suite speaks JSON and had
 * been red on twenty-two tests, in six unrelated features, for exactly this one
 * reason.
 *
 * So: this rule for a field the handler coerces, a named type for a field it
 * does not. It is deliberately permissive - the library has no "string or
 * number or boolean", and inventing a union here would be a second validator to
 * keep true. What the value has to *be* is checked where it is used, which is
 * also where the error is worth reading: "Required approvals is a whole number
 * from 0 to 20" rather than "Must be a string".
 *
 * `tests/unit/action-inputs.test.ts` fails when a handler coerces a field its
 * action declares as a string, because the symptom is a 422 nobody sees until
 * somebody writes a client.
 */
export const coerced = schema.custom(
  () => true,
  // Never reached - the predicate above has no false branch. `custom` takes the
  // message as a second argument regardless, and one that could be read as
  // "this rejects some values" would be worse than none.
  'accepted as sent, and checked where it is used',
)
