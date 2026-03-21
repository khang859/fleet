# Automation Builder Product Ask

## Summary

Fleet should add an automation builder that lets users create recurring or on-demand workflows inside a polished visual UI. The goal is to let a user connect scheduled jobs, LLM-powered steps, scripts, and third-party actions like Gmail or Slack without leaving Fleet.

This is a product ask only. It intentionally avoids technical architecture and implementation detail.

## Problem

Fleet is already good at helping developers run multiple AI agents and terminal sessions, but it does not yet help them automate repeated work.

Users often want things like:

- Run a prompt every morning and post the result to Slack
- Check something on a schedule and send an email if it changes
- Chain a script into an LLM step and then send the output somewhere else
- Set up small background automations without building a separate service

Right now, that kind of work lives in scattered cron jobs, shell scripts, agent prompts, Zapier-style tools, or one-off local setups. That is fragmented and harder to manage than it should be.

## Product Goal

Fleet should make automation feel like a natural extension of working with agents.

The product should let a user:

- Create an automation in a visual editor
- Define when it runs, such as manually or on a schedule
- Add steps that use prompts, scripts, or connected services
- Review what happened on each run
- Edit, test, enable, disable, and duplicate automations from the app

The experience should feel powerful for developers, but still much more approachable than writing raw cron jobs and glue code by hand.

## Core User Experience

The automation builder should feel like a clean, intentional workflow editor inside Fleet.

The user experience should include:

- A dedicated Automations area in the app
- A nice visual builder for assembling multi-step flows
- Clear step configuration forms instead of raw JSON by default
- Easy testing so a user can run a workflow immediately
- Run history with success, failure, and step-by-step output visibility
- Templates for common workflows so the user is not starting from a blank screen every time

## Example Workflows

- Every weekday at 9 AM, ask an LLM to summarize open PRs and send the result to Slack
- Run a local script, pass the output into an LLM, and email the formatted result
- Check an HTTP endpoint on a schedule and notify a Slack channel if the response looks wrong
- Trigger a recurring research or reporting task without manually opening an agent every time

## V1 Scope

The first version should focus on a narrow but strong product surface.

V1 should prioritize:

- Manual runs
- Scheduled runs
- LLM-powered steps
- Script steps
- Slack actions
- Gmail actions
- Generic webhook or HTTP steps
- A visual editor
- Run history and basic debugging visibility

## Non-Goals For V1

To keep the product focused, V1 does not need to solve everything.

V1 does not need:

- A huge marketplace of integrations
- Enterprise workflow management
- Complex no-code branching for every edge case
- Team collaboration workflows
- Full business-process automation positioning

This should start as a strong developer automation feature inside Fleet, not as a general-purpose Zapier replacement.

## Target User

The target user is a developer or highly technical user already living in Fleet and already comfortable with AI tools, scripts, and local workflows.

This user wants more leverage from Fleet:

- Less repetitive prompting
- Less manual copy/paste between tools
- Less need to wire together cron, shell scripts, and external automation services
- More confidence that recurring workflows are visible and manageable in one place

## Product Principles

- Automations should feel agent-native, not bolted on
- The UI should be polished and easy to understand
- Powerful workflows should not require raw config for common cases
- Users should be able to inspect what happened after every run
- The first version should be opinionated and focused rather than overly broad

## Success Criteria

This feature is successful if a Fleet user can set up and trust small recurring workflows such as summaries, checks, notifications, and scripted AI tasks entirely from within the app.

In practical terms, success looks like:

- Users can build useful automations without writing a separate service
- Common workflows take minutes to set up instead of an hour of scripting
- Failures are visible and understandable
- Fleet becomes not just a place to run agents, but also a place to operationalize them
