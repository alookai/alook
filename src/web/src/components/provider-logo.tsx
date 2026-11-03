import type { ComponentPropsWithoutRef } from "react";
import { Monitor } from "lucide-react";

function ClaudeLogo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="#D97757" className={className}>
      <path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z" />
    </svg>
  );
}

export function OpenAILogo({ className, ...props }: ComponentPropsWithoutRef<"svg">) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      data-provider-logo="openai"
      {...props}
    >
      <path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z" />
    </svg>
  );
}

function OpenCodeLogo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 240 300" fill="none" className={className}>
      <path d="M180 240H60V120H180V240Z" fill="#CFCECD" />
      <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#211E1E" />
    </svg>
  );
}

function OpenClawLogo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M8 2C5.5 2 3.5 4 3.5 6.5S5 10.5 6.5 11v1.5H8V11c.3.1.7.1 1 0v1.5h1.5V11c1.5-.5 3-2.5 3-4.5S10.5 2 8 2Z"
        fill="#E8453A"
      />
      <path d="M3.5 5.5C2 5 1 6 1.5 7s2 .5 2.2-.7" fill="#FF6B5A" />
      <path d="M12.5 5.5c1.5-.5 2.5.5 2 1.5s-2 .5-2.2-.7" fill="#FF6B5A" />
      <path d="M6.5 3Q5 1.2 4.3 1.5" stroke="#FF6B5A" strokeWidth="0.8" strokeLinecap="round" />
      <path d="M9.5 3Q11 1.2 11.7 1.5" stroke="#FF6B5A" strokeWidth="0.8" strokeLinecap="round" />
      <circle cx="6.2" cy="5.2" r="0.9" fill="#050810" />
      <circle cx="9.8" cy="5.2" r="0.9" fill="#050810" />
      <circle cx="6.4" cy="5" r="0.3" fill="#00E5CC" />
      <circle cx="10" cy="5" r="0.3" fill="#00E5CC" />
    </svg>
  );
}

const HERMES_ICON =
  "data:image/webp;base64,UklGRuYDAABXRUJQVlA4INoDAADQEwCdASowADAAPm0uk0ckIiGhKrqpWIANiWkAEyQea/fD8IewvGL5V7Nb3H8u/MA8G9rT+4flL+UfIe42/23GB8zPqF/o3E0UAP5h/h/+F6ZX+x5evnX/r+4T/K/67/u/zg7znogfrusMANZLkn1gvlY/vNsKubtj/9xLSzxTsLr7K9GLdFNs5rwtISRcPXvH4z57n2fg0XR3aQ2D+pPpycwyl7TwAAD+/2DbjivnePzfyHCsdOgJXKlUR/OgAkofD7K4AdmsPKyP5Ml4/4HBYmIm5/efn/H+X3IZtngyaUOvwbFuRS/1yODFYO3vf3qeXGgPdfgIROXd/EPT7K2jysfvY9N71+w6g2gBPs+P6lxYkPf6S9QfpvH/7Pp7i8xRh0nVDBTEQyczSz7V9hoqo4nDJuii+SfibZRR/d5zB+9jkcb1DNN7YnC5Y7+WfGrE3eseXt3hSm+NS5++m1MHbjsrd9z/Q4HPRP/C85Po41XObalGyIUcFUL2j2n3uI/Yh6U8r6trCUJFB4kT3fsv6+8ylX/d96y2hq869FCXLjq4YqEO8vs5BtT52sf7KyDxPAWkH/b06YbfVXf4/7y5THL6Sr/4mOrrY9P2LW81f05HHFN8n0jcyqKOH7AluMm0AHPgFyz8RVrfBdmnPiC2FLMQfNDte5yGFzGC3fMlDed/tS/PO3Q/hjsNLvAXUUjqHyCo3JeN69jyNgWjjf8iUqoBsXT+lJyp2r8p60ad1jxhNyTblyJwda8aWEw1hFDeGjpMGguDF66RL4c+ZO+PhculC6WxvCsZ7IPAsdD7/ywx3w3AowJ66hAAK7k+m6X2QV06OVOCwyIGERex/AUyuBbLUK93X58+M+Si7YfYjVYGpoJ7JvSgD8ExaA21z9OY+si+1wreacDanKnFDmhwBQC3t6MLeXCOGp3VURDKl10K7tdKHQcb4hr48ba+1x/MrMRwHfq3IQrDIXPYCg4b0OLnVN9JyXttKGM63B5imIdKuU0r6hhSslT10lGLjnIJuwO5WKR0RHs+BX5vs6H63y3K7IuuZ1eRN+Aczvbs4QuDs6ZRuzjJ/1DJ5R/3ZrFPrtxvMwT06vAXIgcbhLGNLhOQUYRPdUN5MgyCtL5NH71ArTPLRRkIjhGwoCYXKKqlqIKKT9NX3vwp/nlh4SX71dlYg/mPXbJ9bMeVugyjqFahjFTJ/rT3HtBCWG8h+OvvbOFDFKurCG9BOhO9B719OS7zsP0KPqoymnv7hVvoJyZp0iziCbBvaJpmF9Cvfs8/vWqWr7TUo616WfMW+X9nkgpuqtnfAAAAAA==";

function HermesLogo({ className }: { className: string }) {
  return (
    <img
      src={HERMES_ICON}
      alt="Hermes"
      className={`${className} rounded-sm`}
    />
  );
}

function PiLogo({ className }: { className: string }) {
  return <svg viewBox="0 0 560 560" fill="currentColor" className={className} data-provider-logo="pi" aria-hidden="true">
    <path d="M420 280H280V140H0V0H420V280Z" />
    <path d="M560 560H420V280H560V560Z" />
    <path d="M140 560H0V140H140V280H280V420H140V560Z" />
  </svg>;
}

function CopilotLogo({ className }: { className: string }) {
  return <svg viewBox="0 0 24 24" fill="currentColor" className={className} data-provider-logo="copilot" aria-hidden="true">
    <path d="M23.922 16.992c-.861 1.495-5.859 5.023-11.922 5.023-6.063 0-11.061-3.528-11.922-5.023A.641.641 0 0 1 0 16.736v-2.869a.841.841 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952 1.399-1.136 3.392-2.093 6.122-2.093 2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.832.832 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256ZM12.172 11h-.344a4.323 4.323 0 0 1-.355.508C10.703 12.455 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a2.005 2.005 0 0 1-.085-.104L4 11.741v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.016.016Zm.641-2.935c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"/>
    <path d="M14.5 14.25a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Zm-5 0a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Z"/>
  </svg>;
}

function QoderLogo({ className }: { className: string }) {
  return <img src="/providers/qoder.svg" alt="" className={`${className} dark:invert`} data-provider-logo="qoder" />;
}

function CursorLogo({ className }: { className: string }) {
  return (
    <svg viewBox="600 300 400 400" fill="none" className={className} data-provider-logo="cursor" aria-hidden="true">
      <path fill="#14120B" d="M999.994 554.294C999.994 559.859 999.994 565.419 999.962 570.984C999.935 575.67 999.882 580.357 999.753 585.038C999.475 595.247 998.875 605.542 997.059 615.639C995.217 625.88 992.212 635.409 987.477 644.718C982.822 653.861 976.738 662.233 969.485 669.491C962.227 676.748 953.861 682.828 944.712 687.482C935.409 692.217 925.875 695.222 915.633 697.065C905.537 698.88 895.242 699.48 885.033 699.759C880.346 699.887 875.665 699.941 870.978 699.968C865.413 700.005 859.853 700 854.288 700H745.695C740.13 700 734.571 700 729.005 699.968C724.319 699.941 719.632 699.887 714.951 699.759C704.742 699.48 694.447 698.88 684.35 697.065C674.109 695.222 664.58 692.217 655.271 687.482C646.128 682.828 637.756 676.743 630.499 669.491C623.241 662.233 617.161 653.866 612.507 644.718C607.772 635.414 604.767 625.88 602.925 615.639C601.109 605.542 600.509 595.247 600.23 585.038C600.102 580.352 600.048 575.67 600.021 570.984C600 565.419 600 559.859 600 554.294V445.701C600 440.136 600 434.576 600.032 429.011C600.059 424.324 600.112 419.637 600.241 414.956C600.52 404.747 601.119 394.452 602.935 384.356C604.778 374.115 607.783 364.586 612.518 355.277C617.172 346.133 623.257 337.762 630.509 330.504C637.767 323.246 646.133 317.167 655.282 312.512C664.586 307.777 674.12 304.772 684.361 302.93C694.458 301.114 704.752 300.514 714.961 300.236C719.648 300.107 724.329 300.054 729.016 300.027C734.576 300 740.136 300 745.701 300H854.294C859.859 300 865.419 300 870.984 300.032C875.67 300.059 880.357 300.112 885.038 300.241C895.247 300.52 905.542 301.119 915.639 302.935C925.88 304.778 935.409 307.783 944.718 312.518C953.861 317.172 962.233 323.257 969.491 330.509C976.748 337.767 982.828 346.133 987.482 355.282C992.217 364.586 995.222 374.12 997.065 384.361C998.88 394.458 999.48 404.752 999.759 414.961C999.887 419.648 999.941 424.329 999.968 429.016C1000.01 434.581 1000 440.141 1000 445.706V554.299L999.994 554.294Z"/>
      <path fill="#72716D" d="M800.004 500L923.821 571.486C923.061 572.804 921.957 573.929 920.591 574.716L804.863 641.531C801.858 643.266 798.151 643.266 795.146 641.531L679.417 574.716C678.052 573.929 676.948 572.804 676.188 571.486L800.004 500Z"/>
      <path fill="#55544F" d="M800.005 357.168V500L676.188 571.486C675.427 570.168 675.004 568.647 675.004 567.072V432.928C675.004 429.774 676.686 426.865 679.418 425.285L795.141 358.47C796.646 357.602 798.323 357.168 799.999 357.168H800.005Z"/>
      <path fill="#43413C" d="M923.815 428.515C923.055 427.197 921.951 426.072 920.586 425.285L804.857 358.47C803.357 357.602 801.68 357.168 800.004 357.168V500L923.821 571.486C924.581 570.168 925.005 568.647 925.005 567.072V432.928C925.005 431.348 924.587 429.838 923.821 428.515H923.815Z"/>
      <path fill="#D6D5D2" d="M915.156 433.518C915.857 434.728 915.954 436.281 915.156 437.663L802.764 632.323C802.008 633.641 800 633.1 800 631.584V503.311C800 502.287 799.727 501.302 799.229 500.44L915.15 433.512H915.156V433.518Z"/>
      <path fill="white" d="M915.155 433.518L799.233 500.445C798.741 499.588 798.023 498.86 797.134 498.345L686.049 434.209C684.731 433.453 685.272 431.445 686.788 431.445H911.566C913.162 431.445 914.459 432.307 915.155 433.518Z"/>
    </svg>
  );
}

function GeminiLogo({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M12 24C12 18.2 12 15.5 10.1 13.9C8.5 12 5.8 12 0 12C5.8 12 8.5 12 10.1 10.1C12 8.5 12 5.8 12 0C12 5.8 12 8.5 13.9 10.1C15.5 12 18.2 12 24 12C18.2 12 15.5 12 13.9 13.9C12 15.5 12 18.2 12 24Z"
        fill="url(#gemini-gradient)"
      />
      <defs>
        <linearGradient id="gemini-gradient" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4285F4" />
          <stop offset="1" stopColor="#886FBF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function AntigravityLogo({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 180 180"
      fill="none"
      className={className}
      data-provider-logo="antigravity"
      aria-hidden="true"
    >
      <path
        d="M144.248 149.062C151.748 154.688 162.998 150.938 152.685 140.625C121.748 110.625 128.31 28.125 89.8727 28.125C51.4352 28.125 57.9977 110.625 27.0602 140.625C15.8102 151.875 27.9977 154.688 35.4977 149.062C64.5602 129.375 62.6852 94.6875 89.8727 94.6875C117.06 94.6875 115.185 129.375 144.248 149.062Z"
        fill="#202124"
        className="dark:fill-white"
      />
    </svg>
  );
}

function KimiLogo({ className }: { className: string }) {
  // A simple "K" mark — single-color glyph for the Kimi runtime.
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M3.25 2.25a.75.75 0 0 1 .75.75v4.16l4.61-4.69a.75.75 0 0 1 1.07 1.05L6.05 7.21l3.95 5.39a.75.75 0 1 1-1.21.89L5.18 8.5 4 9.7V13a.75.75 0 0 1-1.5 0V3a.75.75 0 0 1 .75-.75Z" />
      <circle cx="12.5" cy="3.5" r="1" />
    </svg>
  );
}

function GrokLogo({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      className={className}
      data-provider-logo="grok"
      aria-hidden="true"
    >
      <path
        d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916"
        className="fill-current"
      />
      <path
        d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339"
        className="fill-current"
      />
    </svg>
  );
}

export function ProviderLogo({
  provider,
  className = "h-4 w-4",
}: {
  provider: string;
  className?: string;
}) {
  switch (provider) {
    case "claude":
      return <ClaudeLogo className={className} />;
    case "codex":
      return <OpenAILogo className={className} />;
    case "opencode":
      return <OpenCodeLogo className={className} />;
    case "openclaw":
      return <OpenClawLogo className={className} />;
    case "hermes":
      return <HermesLogo className={className} />;
    case "pi-durable":
    case "pi":
      return <PiLogo className={className} />;
    case "qoder":
      return <QoderLogo className={className} />;
    case "copilot":
      return <CopilotLogo className={className} />;
    case "cursor-sdk":
    case "cursor":
      return <CursorLogo className={className} />;
    case "gemini":
      return <GeminiLogo className={className} />;
    case "antigravity":
    case "agy":
      return <AntigravityLogo className={className} />;
    case "kimi":
      return <KimiLogo className={className} />;
    case "grok":
      return <GrokLogo className={className} />;
    default:
      return <Monitor className={className} />;
  }
}
