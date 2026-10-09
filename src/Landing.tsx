export default function Landing() {
  // Organization registration form comes later.
  return <section className="landing" lang="en">
    <span className="eyebrow">Puerto Rico · Outage response</span>
    <h1>When the power goes out, know <em>who to call first.</em></h1>
    <p className="lead">VitalPower Relay keeps a consent-based registry of electricity-dependent patients and turns a LUMA outage into a ranked call list for responder organizations.</p>
    <p className="demo-note">Synthetic demo data only.</p>
    <ol className="steps">
      <li><strong>An outage appears</strong><span>We read LUMA's public outage feed every three minutes.</span></li>
      <li><strong>Patients are flagged</strong><span>Registered patients in the affected zone get a check-in: "¿Tiene luz en su casa?"</span></li>
      <li><strong>Responders call</strong><span>Coordinators see a ranked list with the reason for each priority.</span></li>
    </ol>
    <div className="area-links">
      <a href="/app"><strong>Caregiver area</strong><span>Register a patient and answer check-ins.</span></a>
      <a href="/admin"><strong>Coordinator area</strong><span>See the call list for your municipalities.</span></a>
    </div>
  </section>
}
