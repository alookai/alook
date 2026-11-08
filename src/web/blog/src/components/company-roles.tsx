import type { ReactNode } from "react";
import styles from "./company-roles.module.css";
const roles = [
  [
    "Sales",
    "Company brief, prospect notes, customer inquiries",
    "Outreach drafts and a proposed job brief for you to approve"
  ],
  [
    "Delivery",
    "Approved job brief, confirmed customer details, website tools",
    "Website preview, change list, check results, and anything still missing"
  ],
  [
    "Review",
    "Original request, job brief, actual website preview",
    "Specific fixes for Delivery, or a checked preview ready for your approval"
  ],
  [
    "Customer Ops",
    "Review findings, your decisions, customer replies, delivery and invoice records",
    "Job updates, follow-ups, and a short list of decisions waiting for you"
  ]
];
export function CompanyRoles({ avatars }: { avatars: ReactNode[] }) {
  return <table className={styles.roles} aria-label="Four agent roles: inputs and required results">
    <thead><tr><th scope="col">Agent</th><th scope="col">What it works from</th><th scope="col">What you get back</th></tr></thead>
    <tbody>{roles.map(([name, inputs, result], i) => <tr key={name}>
      <th scope="row">{avatars[i]}<span>{name}</span></th>
      <td data-label="What it works from">{inputs}</td><td data-label="What you get back">{result}</td>
    </tr>)}</tbody>
  </table>;
}
