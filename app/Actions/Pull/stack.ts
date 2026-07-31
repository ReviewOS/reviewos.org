/**
 * Stack rules, for server-side callers.
 *
 * The logic itself lives in `resources/functions/stack.ts` because a view has
 * to reach it, and stx strips a composable's imports before evaluating it: an
 * export whose value comes from an import is left undefined, with no error. A
 * module that imports nothing cannot be broken that way, so the rules live
 * there and the actions import them from here.
 */

export * from '../../../resources/functions/stack'
