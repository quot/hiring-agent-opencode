import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const SECTION_NAMES = ["basics", "work", "education", "skills", "projects", "awards"] as const

const DISABLED_TOOLS = {
  bash: false,
  read: false,
  edit: false,
  grep: false,
  glob: false,
  list: false,
  webfetch: false,
  websearch: false,
}

const PROMPT_TEMPLATE_FILES = {
  basics: "prompts/templates/basics.jinja",
  work: "prompts/templates/work.jinja",
  education: "prompts/templates/education.jinja",
  skills: "prompts/templates/skills.jinja",
  projects: "prompts/templates/projects.jinja",
  awards: "prompts/templates/awards.jinja",
  system_message: "prompts/templates/system_message.jinja",
  github_project_selection: "prompts/templates/github_project_selection.jinja",
  resume_evaluation_criteria: "prompts/templates/resume_evaluation_criteria.jinja",
  resume_evaluation_system_message: "prompts/templates/resume_evaluation_system_message.jinja",
} as const

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function selectPython(worktree: string) {
  const envPython = process.env.OPENCODE_RESUME_PYTHON
  if (envPython) return envPython

  const venvPython = path.join(worktree, ".venv", "bin", "python")
  if (existsSync(venvPython)) return venvPython
  if (existsSync("/opt/homebrew/bin/python3.11")) return "/opt/homebrew/bin/python3.11"
  return "python3.11"
}

function parseModel() {
  const model = process.env.OPENCODE_RESUME_MODEL || "openai/gpt-5.5"
  const slashIndex = model.indexOf("/")
  if (slashIndex === -1) {
    throw new Error("OPENCODE_RESUME_MODEL must use provider/model format")
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  }
}

function resolvePdfPath(pdfPath: string, directory: string) {
  const resolved = path.isAbsolute(pdfPath) ? pdfPath : path.resolve(directory, pdfPath)
  if (!existsSync(resolved)) throw new Error(`PDF file not found: ${resolved}`)
  return resolved
}

function outputFromResponse<T>(response: T): any {
  const value = response as any
  if (value?.error) throw new Error(JSON.stringify(value.error))
  return value?.data ?? value
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex")
}

async function hashFile(filePath: string) {
  return sha256(await readFile(filePath))
}

function parseJson(stdout: string, label: string) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`Invalid JSON from ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function bridgeEnv() {
  const env = { ...process.env }
  delete env.LLM_PROVIDER
  delete env.GEMINI_API_KEY
  return env
}

async function runBridge(worktree: string, args: string[], signal: AbortSignal) {
  const python = selectPython(worktree)
  const bridge = path.join(worktree, "opencode_bridge.py")

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(python, [bridge, ...args], {
      cwd: worktree,
      env: bridgeEnv(),
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`Bridge command failed (${args.join(" ")}): ${stderr || stdout}`))
    })
  })
}

async function writeJson(directory: string, name: string, data: unknown) {
  const filePath = path.join(directory, name)
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  return filePath
}

async function readBridgeJson(worktree: string, args: string[], label: string, signal: AbortSignal) {
  return parseJson(await runBridge(worktree, args, signal), label)
}

async function validateModel(worktree: string, tempDir: string, modelName: string, data: unknown, signal: AbortSignal) {
  const inputPath = await writeJson(tempDir, `${modelName.replace(/[^a-z0-9_-]/gi, "_")}-validate-input.json`, data)
  return readBridgeJson(worktree, ["validate", modelName, "--input", inputPath], `validate ${modelName}`, signal)
}

async function renderPrompt(worktree: string, tempDir: string, task: string, payload: unknown, signal: AbortSignal) {
  const inputPath = await writeJson(tempDir, `${task.replace(/[^a-z0-9_-]/gi, "_")}-prompt-input.json`, payload)
  return runBridge(worktree, ["render-prompt", task, "--input", inputPath], signal)
}

async function promptStructured(input: {
  client: any
  sessionID: string
  directory: string
  agent: string
  system: string
  prompt: string
  schema: unknown
}) {
  const prompted = await input.client.session.prompt({
    path: { id: input.sessionID },
    query: { directory: input.directory },
    body: {
      agent: input.agent,
      model: parseModel(),
      tools: DISABLED_TOOLS,
      system: input.system,
      parts: [{ type: "text", text: input.prompt }],
      format: {
        type: "json_schema",
        retryCount: 1,
        schema: input.schema,
      },
    } as any,
  })

  const result = outputFromResponse(prompted)
  const structured = result?.info?.structured
  if (structured === undefined || structured === null) {
    throw new Error("OpenCode structured output was missing from result.info.structured")
  }
  return structured
}

function findGithubUrl(resume: any) {
  const basics = resume?.basics
  if (typeof basics?.url === "string" && /github\.com/i.test(basics.url)) return basics.url

  if (!Array.isArray(basics?.profiles)) return undefined
  for (const profile of basics.profiles) {
    const network = typeof profile?.network === "string" ? profile.network.toLowerCase() : ""
    const url = typeof profile?.url === "string" ? profile.url : undefined
    const username = typeof profile?.username === "string" ? profile.username : undefined
    if (url && /github\.com/i.test(url)) return url
    if (network === "github" && username) return username
  }
  return undefined
}

function artifactRunName(pdfPath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const slug = path.basename(pdfPath, path.extname(pdfPath)).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "resume"
  return `${timestamp}-${slug}`
}

async function collectPromptTemplateHashes(worktree: string) {
  const entries = await Promise.all(
    Object.entries(PROMPT_TEMPLATE_FILES).map(async ([name, relativePath]) => [name, await hashFile(path.join(worktree, relativePath))] as const),
  )
  return Object.fromEntries(entries)
}

export default (async ({ client }) => {
  return {
    tool: {
      resume_evaluate: tool({
        description: "Evaluate a resume PDF through OpenCode structured AI calls and deterministic Python helpers.",
        args: {
          pdf_path: tool.schema.string().describe("Path to the resume PDF, relative to the current project/session directory or absolute."),
          include_github: tool.schema.boolean().optional().describe("Fetch and include GitHub repository context when a GitHub profile is found. Defaults to true."),
          write_artifacts: tool.schema.boolean().optional().describe("Write intermediate artifacts under .artifacts/resume-evaluations/. Defaults to false."),
          output_format: tool.schema.enum(["summary", "json", "both"]).optional().describe("Tool output format. Defaults to both."),
        },
        async execute(args, context) {
          const worktree = context.worktree || context.directory
          const directory = context.directory || worktree
          const outputFormat = args.output_format || "both"
          const includeGithub = args.include_github !== false
          const agent = process.env.OPENCODE_RESUME_AGENT || "resume-evaluator"
          const pdfPath = resolvePdfPath(args.pdf_path, directory)
          const runName = artifactRunName(pdfPath)
          const tempDir = await mkdtemp(path.join(tmpdir(), "opencode-resume-evaluation-"))
          const artifactDir = args.write_artifacts
            ? path.join(worktree, ".artifacts", "resume-evaluations", runName)
            : undefined
          const artifactPaths: string[] = []
          const warnings: string[] = []
          const sections: Record<string, unknown> = {}
          const pdfHashPromise = hashFile(pdfPath)
          const promptTemplateHashesPromise = artifactDir ? collectPromptTemplateHashes(worktree) : Promise.resolve(undefined)

          if (artifactDir) await mkdir(artifactDir, { recursive: true })

          const saveArtifact = async (name: string, data: string | unknown) => {
            if (!artifactDir) return undefined
            const filePath = path.join(artifactDir, name)
            const content = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`
            await writeFile(filePath, content, "utf8")
            artifactPaths.push(filePath)
            return filePath
          }

          try {
            context.metadata({ title: "Extracting resume text" })
            const resumeMarkdown = await runBridge(worktree, ["extract-text", pdfPath], context.abort)
            await saveArtifact("resume.md", resumeMarkdown)

            const sessionResponse = await client.session.create({
              query: { directory },
              body: {
                parentID: context.sessionID,
                title: `Resume evaluation: ${path.basename(pdfPath)}`,
              },
            })
            const session = outputFromResponse(sessionResponse)
            const sessionID = session.id

            const sectionsDir = path.join(tempDir, "sections")
            await mkdir(sectionsDir, { recursive: true })

            for (const section of SECTION_NAMES) {
              context.metadata({ title: `Extracting ${section}` })
              const [system, prompt, schema] = await Promise.all([
                renderPrompt(worktree, tempDir, "system_message", { section_name: section }, context.abort),
                renderPrompt(worktree, tempDir, section, { text_content: resumeMarkdown }, context.abort),
                readBridgeJson(worktree, ["schema", section], `schema ${section}`, context.abort),
              ])
              const rawSection = await promptStructured({ client, sessionID, directory, agent, system, prompt, schema })
              await saveArtifact(`${section}.raw.json`, rawSection)

              const rawSectionPath = await writeJson(tempDir, `${section}-raw.json`, rawSection)
              const normalizedSection = await readBridgeJson(
                worktree,
                ["normalize-section", section, "--input", rawSectionPath],
                `normalize ${section}`,
                context.abort,
              )
              await writeJson(sectionsDir, `${section}.json`, normalizedSection)
              await saveArtifact(`${section}.json`, normalizedSection)
              sections[section] = normalizedSection
            }

            await saveArtifact("sections.json", sections)

            context.metadata({ title: "Merging resume sections" })
            const resume = await readBridgeJson(worktree, ["merge-resume", "--sections", sectionsDir], "merge resume", context.abort)
            await saveArtifact("resume.json", resume)

            let githubRaw: unknown | undefined
            let githubSelected: unknown | undefined
            let githubForEvaluation: unknown | undefined
            const githubUrl = findGithubUrl(resume)
            if (includeGithub && githubUrl) {
              try {
                context.metadata({ title: "Fetching GitHub context" })
                githubRaw = await readBridgeJson(worktree, ["fetch-github", githubUrl, "--max-repos", "100"], "fetch github", context.abort)
                await saveArtifact("github_raw.json", githubRaw)

                const [githubPrompt, githubSchema] = await Promise.all([
                  renderPrompt(worktree, tempDir, "github_project_selection", { projects_data: githubRaw }, context.abort),
                  readBridgeJson(worktree, ["schema", "github_selected_projects"], "schema github_selected_projects", context.abort),
                ])
                const wrappedGithubPrompt = `${githubPrompt}\n\nFor this OpenCode structured output call, return an object with exactly this shape: { "projects": [selected project objects] }. Do not return a top-level array.`
                const rawSelected = await promptStructured({
                  client,
                  sessionID,
                  directory,
                  agent,
                  system: "Select GitHub projects as structured JSON only. Use only the supplied repository data.",
                  prompt: wrappedGithubPrompt,
                  schema: githubSchema,
                })
                const githubSelectedResult = await validateModel(worktree, tempDir, "github_selected_projects", rawSelected, context.abort)
                githubSelected = Array.isArray((githubSelectedResult as any)?.projects) ? (githubSelectedResult as any).projects : []
                githubForEvaluation = {
                  profile: (githubRaw as any)?.profile,
                  projects: githubSelected,
                  total_projects: Array.isArray(githubSelected) ? githubSelected.length : 0,
                  fetched_at: (githubRaw as any)?.fetched_at,
                }
                await saveArtifact("github_selected.json", githubSelected)
                await saveArtifact("github_context.json", githubForEvaluation)
              } catch (error) {
                warnings.push(`GitHub enrichment skipped: ${error instanceof Error ? error.message : String(error)}`)
                githubRaw = undefined
                githubSelected = undefined
                githubForEvaluation = undefined
              }
            } else if (includeGithub) {
              warnings.push("GitHub enrichment skipped: no GitHub profile URL found in extracted basics")
            }

            context.metadata({ title: "Evaluating resume" })
            const evaluationInputPath = await writeJson(tempDir, "resume-for-evaluation.json", resume)
            const githubInputPath = githubForEvaluation ? await writeJson(tempDir, "github-for-evaluation.json", githubForEvaluation) : undefined
            const evaluationInput = await runBridge(
              worktree,
              ["format-evaluation-input", "--resume", evaluationInputPath, ...(githubInputPath ? ["--github", githubInputPath] : [])],
              context.abort,
            )
            await saveArtifact("evaluation_input.txt", evaluationInput)

            const [evaluationSystem, evaluationPrompt, evaluationSchema] = await Promise.all([
              renderPrompt(worktree, tempDir, "resume_evaluation_system_message", {}, context.abort),
              renderPrompt(worktree, tempDir, "resume_evaluation_criteria", { text_content: evaluationInput }, context.abort),
              readBridgeJson(worktree, ["schema", "evaluation"], "schema evaluation", context.abort),
            ])
            const rawEvaluation = await promptStructured({
              client,
              sessionID,
              directory,
              agent,
              system: evaluationSystem,
              prompt: evaluationPrompt,
              schema: evaluationSchema,
            })
            await saveArtifact("evaluation.raw.json", rawEvaluation)
            const evaluation = await validateModel(worktree, tempDir, "evaluation", rawEvaluation, context.abort)
            await saveArtifact("evaluation.json", evaluation)

            const evaluationPath = await writeJson(tempDir, "evaluation.json", evaluation)
            const report = await runBridge(worktree, ["format-report", "--evaluation", evaluationPath], context.abort)
            await saveArtifact("report.md", report)
            const [pdfHash, promptTemplateHashes] = await Promise.all([
              pdfHashPromise,
              promptTemplateHashesPromise,
            ])
            const artifactManifestPaths = [...artifactPaths, ...(artifactDir ? [path.join(artifactDir, "metadata.json")] : [])]
            const metadata = {
              artifact_schema_version: 2,
              run_name: runName,
              artifact_dir: artifactDir,
              pdf_path: pdfPath,
              pdf_sha256: pdfHash,
              nested_session_id: sessionID,
              model: process.env.OPENCODE_RESUME_MODEL || "openai/gpt-5.5",
              model_provider: parseModel().providerID,
              model_id: parseModel().modelID,
              agent,
              include_github: includeGithub,
              github_included: Boolean(githubForEvaluation),
              prompt_template_hashes: promptTemplateHashes,
              warnings,
              created_at: new Date().toISOString(),
              artifact_paths: artifactManifestPaths,
            }
            await saveArtifact("metadata.json", {
              ...metadata,
            })

            const jsonOutput = JSON.stringify({ evaluation, resume, github: githubForEvaluation ?? null, metadata }, null, 2)
            const output = outputFormat === "summary"
              ? report
              : outputFormat === "json"
                ? jsonOutput
                : `${report}\n\n## Structured Result\n\n\`\`\`json\n${jsonOutput}\n\`\`\``

            return {
              title: "Resume evaluation complete",
              output,
              metadata,
            }
          } finally {
            await rm(tempDir, { recursive: true, force: true })
          }
        },
      }),
    },
  }
}) satisfies Plugin
