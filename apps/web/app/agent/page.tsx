import Ask from './ask';

export const dynamic = 'force-dynamic';

/**
 * The agent, on its own route so it is demonstrable separately from the
 * retrieval feature — the brief asks for a link to each.
 */
export default function AgentPage() {
  return (
    <div className="wrap">
      <header>
        <h1 className="brand">Sightline · agent</h1>
        <p className="tagline">
          Answers over released, gate-passed claims only. It decides how to answer;
          it does not decide what is true.
        </p>
      </header>

      <Ask />

      <section>
        <h2>Its authority</h2>
        <p className="note">
          <strong>Decides alone:</strong> how to break down the question, which tools to
          call and in what order, when it has enough, how to structure the reply.
        </p>
        <p className="note">
          <strong>Must abstain:</strong> any claim not backed by released data; any ranking
          on a metric no claim holds; any characterisation of a contact beyond its
          recorded <span className="mono">reaches</span> value.
        </p>
        <p className="note">
          <strong>Must refuse:</strong> naming a firm not in the dataset; upgrading a label
          — a company inbox is not a principal&apos;s email, &ldquo;not found&rdquo; is not
          &ldquo;does not exist&rdquo;; and answering a narrower question than the one asked
          without saying so.
        </p>
        <p className="note">
          That last one was Stage 1&apos;s live failure. It is now enforced in control flow:
          the planner records constraints it cannot honour, and if the composed answer does
          not visibly surface them the answer is blocked and rewritten. A prompt instruction
          would not have caught it, because the model was not aware it had substituted.
        </p>
      </section>

      <footer>
        Extraction, validation and release are fixed pipelines with no model deciding
        control flow. A model that can decide whether a claim is released can decide to
        release a bad one.
      </footer>
    </div>
  );
}
