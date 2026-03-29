"""
Email Notification Module for LP Strategy v2.

Sends email notifications with CSV attachments for key events:
- App startup
- Position opened
- Position closed
- Rebalance executed
- Swap executed on Jupiter

Uses SMTP (Gmail/Outlook compatible) for email delivery.
"""

import os
import ssl
import smtplib
import logging
from email.message import EmailMessage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Optional, List, Dict, Any
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class EmailConfig:
    """Email notification configuration."""
    enabled: bool = False
    smtp_server: str = "smtp.gmail.com"
    smtp_port: int = 465
    sender_email: str = ""
    sender_password: str = ""
    recipients: List[str] = None  # List of recipient emails

    def __post_init__(self):
        if self.recipients is None:
            self.recipients = []


def get_email_config() -> EmailConfig:
    """
    Load email configuration from environment variables.

    Environment variables:
    - EMAIL_ENABLED: 'true' to enable notifications
    - EMAIL_SMTP_SERVER: SMTP server (default: smtp.gmail.com)
    - EMAIL_SMTP_PORT: SMTP port (default: 465)
    - EMAIL_SENDER: Sender email address
    - EMAIL_PASSWORD: SMTP password or app password
    - EMAIL_RECIPIENTS: Comma-separated list of recipient emails
    """
    recipients_str = os.getenv('EMAIL_RECIPIENTS', '')
    recipients = [e.strip() for e in recipients_str.split(',') if e.strip()]

    return EmailConfig(
        enabled=os.getenv('EMAIL_ENABLED', 'false').lower() in ('true', '1', 'yes'),
        smtp_server=os.getenv('EMAIL_SMTP_SERVER', 'smtp.gmail.com'),
        smtp_port=int(os.getenv('EMAIL_SMTP_PORT', '465')),
        sender_email=os.getenv('EMAIL_SENDER', ''),
        sender_password=os.getenv('EMAIL_PASSWORD', ''),
        recipients=recipients,
    )


class EmailNotifier:
    """
    Handles email notifications for LP Strategy events.

    Sends formatted HTML emails with:
    - Event-specific information
    - Current session state
    - Market data and trends
    - Position details
    - CSV log attachments
    """

    def __init__(self, config: Optional[EmailConfig] = None, data_dir: Optional[str] = None):
        self.config = config or get_email_config()
        self.data_dir = Path(data_dir) if data_dir else Path('/data')
        self._session_id: Optional[str] = None

    @property
    def is_enabled(self) -> bool:
        """Check if email notifications are properly configured and enabled."""
        return (
            self.config.enabled and
            self.config.sender_email and
            self.config.sender_password and
            len(self.config.recipients) > 0
        )

    def set_session_id(self, session_id: str) -> None:
        """Set the current session ID for finding CSV files."""
        self._session_id = session_id

    def _get_csv_files(self) -> List[Path]:
        """Get list of CSV files for current session.

        Includes both:
        1. New LP Management & Asset/Fees Management CSVs (primary logs)
        2. Legacy session-based CSVs (for backward compatibility)
        """
        csv_files = []

        # NEW: LP Management, Asset/Fees Management, and Pool State History CSVs
        # These are the primary log files in the new format
        new_format_files = [
            "lp_management.csv",
            "asset_fees_management.csv",
            "pool_state_history.csv",
        ]

        for filename in new_format_files:
            file_path = self.data_dir / filename
            if file_path.exists():
                csv_files.append(file_path)

        # LEGACY: Session-based CSVs (for backward compatibility)
        if self._session_id:
            legacy_patterns = [
                f"session_{self._session_id}_snapshots.csv",
                f"session_{self._session_id}_rebalances.csv",
                f"session_{self._session_id}_swaps.csv",
                f"session_{self._session_id}_wsol_cleanup.csv",
                f"session_{self._session_id}_pool_state.csv",
            ]

            for pattern in legacy_patterns:
                file_path = self.data_dir / pattern
                if file_path.exists():
                    csv_files.append(file_path)

        return csv_files

    def _send_email(
        self,
        subject: str,
        html_body: str,
        text_body: str,
        attach_csvs: bool = True
    ) -> bool:
        """
        Send email with optional CSV attachments.

        Returns True if successful, False otherwise.
        """
        if not self.is_enabled:
            logger.debug("Email notifications disabled or not configured")
            return False

        try:
            # Create multipart message
            msg = MIMEMultipart('mixed')
            msg['From'] = self.config.sender_email
            msg['To'] = ', '.join(self.config.recipients)
            msg['Subject'] = subject

            # Create alternative part for text/html
            alt_part = MIMEMultipart('alternative')

            # Add plain text version
            text_part = MIMEText(text_body, 'plain')
            alt_part.attach(text_part)

            # Add HTML version
            html_part = MIMEText(html_body, 'html')
            alt_part.attach(html_part)

            msg.attach(alt_part)

            # Attach CSV files if requested
            if attach_csvs:
                for csv_path in self._get_csv_files():
                    try:
                        with open(csv_path, 'rb') as f:
                            part = MIMEBase('application', 'octet-stream')
                            part.set_payload(f.read())
                            encoders.encode_base64(part)
                            part.add_header(
                                'Content-Disposition',
                                f'attachment; filename="{csv_path.name}"'
                            )
                            msg.attach(part)
                    except Exception as e:
                        logger.warning(f"Failed to attach {csv_path.name}: {e}")

            # Send email
            context = ssl.create_default_context()

            with smtplib.SMTP_SSL(
                self.config.smtp_server,
                self.config.smtp_port,
                context=context
            ) as server:
                server.login(self.config.sender_email, self.config.sender_password)
                server.send_message(msg)

            logger.info(f"Email sent: {subject}")
            return True

        except Exception as e:
            logger.error(f"Failed to send email: {e}")
            return False

    def _format_price(self, price: float) -> str:
        """Format price for display."""
        return f"${price:,.4f}"

    def _format_sol(self, amount: float) -> str:
        """Format SOL amount for display."""
        return f"{amount:,.6f} SOL"

    def _format_usdc(self, amount: float) -> str:
        """Format USDC amount for display."""
        return f"${amount:,.2f} USDC"

    def _format_pct(self, pct: float) -> str:
        """Format percentage for display. Expects value like 5.81 for 5.81%."""
        return f"{pct:,.2f}%"

    def _format_pct_from_decimal(self, decimal_value: float) -> str:
        """Format decimal to percentage for display. Converts 0.0581 to '5.81%'."""
        return f"{decimal_value * 100:,.2f}%"

    def _build_session_info_html(
        self,
        session_state: Optional[Dict[str, Any]] = None
    ) -> str:
        """Build HTML section for session information."""
        if not session_state:
            return ""

        # Check if session just started (< 1 minute = 0.017 hours)
        duration_hours = session_state.get('duration_hours', 0)
        is_just_started = duration_hours < 0.02  # Less than ~1 minute

        # For just-started sessions, PnL is unreliable (position just opened)
        if is_just_started:
            pnl_html = '<em style="color: #666;">Calculating...</em> (session just started)'
        else:
            net_pnl_usd = session_state.get('net_pnl_usd', 0)
            net_pnl_pct = session_state.get('net_pnl_pct', 0)
            # Color code PnL: green for positive, red for negative
            pnl_color = '#28a745' if net_pnl_usd >= 0 else '#dc3545'
            pnl_html = f'<span style="color: {pnl_color};">${net_pnl_usd:,.2f} ({net_pnl_pct:.2f}%)</span>'

        return f"""
        <h3>Session State</h3>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
            <tr><td><strong>Session ID</strong></td><td>{session_state.get('session_id', 'N/A')}</td></tr>
            <tr><td><strong>Start Time</strong></td><td>{session_state.get('start_time', 'N/A')}</td></tr>
            <tr><td><strong>Duration</strong></td><td>{duration_hours:.2f} hours</td></tr>
            <tr><td><strong>Initial Value</strong></td><td>${session_state.get('initial_value_usd', 0):,.2f}</td></tr>
            <tr><td><strong>Current Value</strong></td><td>${session_state.get('current_value_usd', 0):,.2f}</td></tr>
            <tr><td><strong>Net PnL</strong></td><td>{pnl_html}</td></tr>
            <tr><td><strong>Total Rebalances</strong></td><td>{session_state.get('total_rebalances', 0)}</td></tr>
            <tr><td><strong>Emergency Rebalances</strong></td><td>{session_state.get('emergency_rebalances', 0)}</td></tr>
        </table>
        """

    def _build_market_info_html(
        self,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        price_source: str = "pool",  # "pool" or "birdeye"
        pool_sqrt_price: int = 0,
        pool_tick: int = 0,
    ) -> str:
        """Build HTML section for market information."""
        # Calculate range width safely
        range_width_pct = ((upper_target - lower_target) / price * 100) if price > 0 else 0

        # Price source indicator
        if price_source == "pool":
            source_html = '<span style="color: #28a745; font-weight: bold;">ON-CHAIN POOL</span>'
            source_note = "Price derived directly from pool sqrt_price (authoritative)"
        else:
            source_html = '<span style="color: #ff9800;">Birdeye API</span>'
            source_note = "Price from external API (may differ from pool)"

        # Pool math details (only show if we have them)
        pool_details = ""
        if pool_sqrt_price > 0 or pool_tick != 0:
            pool_details = f"""
                <tr><td><strong>Pool sqrt_price</strong></td><td><code>{pool_sqrt_price}</code></td></tr>
                <tr><td><strong>Pool Tick</strong></td><td>{pool_tick:,}</td></tr>
            """

        return f"""
        <h3>Market Data</h3>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
            <tr><td><strong>Current Price</strong></td><td>{self._format_price(price)}</td></tr>
            <tr><td><strong>Price Source</strong></td><td>{source_html}</td></tr>
            {pool_details}
            <tr><td><strong>ATR (14-day)</strong></td><td>{self._format_pct_from_decimal(atr_pct)}</td></tr>
            <tr><td><strong>Target Range</strong></td><td>{self._format_price(lower_target)} - {self._format_price(upper_target)}</td></tr>
            <tr><td><strong>Range Width</strong></td><td>{self._format_pct(range_width_pct)}</td></tr>
        </table>
        <p style="font-size: 11px; color: #666; margin-top: 5px;"><em>{source_note}</em></p>
        """

    def _build_pool_info_html(
        self,
        pool_address: str,
        tick_current: int = 0,
        liquidity: int = 0,
        tick_spacing: int = 1,
    ) -> str:
        """Build HTML section for pool state information."""
        return f"""
        <h3>Pool State</h3>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
            <tr><td><strong>Pool Address</strong></td><td><code>{pool_address}</code></td></tr>
            <tr><td><strong>Current Tick</strong></td><td>{tick_current:,}</td></tr>
            <tr><td><strong>Liquidity</strong></td><td>{liquidity:,}</td></tr>
            <tr><td><strong>Tick Spacing</strong></td><td>{tick_spacing}</td></tr>
        </table>
        """

    def _build_wallet_info_html(
        self,
        sol_balance: float,
        usdc_balance: float,
        price: float,
    ) -> str:
        """Build HTML section for wallet balances."""
        total_usd = (sol_balance * price) + usdc_balance
        return f"""
        <h3>Wallet Balances</h3>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
            <tr><td><strong>SOL Balance</strong></td><td>{self._format_sol(sol_balance)}</td></tr>
            <tr><td><strong>USDC Balance</strong></td><td>{self._format_usdc(usdc_balance)}</td></tr>
            <tr><td><strong>Total Value (USD)</strong></td><td>${total_usd:,.2f}</td></tr>
        </table>
        """

    def _build_debug_info_html(
        self,
        open_attempts: int = 0,
        open_errors: Optional[List[str]] = None,
        fully_succeeded: bool = True,
        extra_info: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Build HTML section for debugging information (shown when there are errors)."""
        if fully_succeeded and not open_errors:
            return ""  # No debug info needed if everything succeeded

        errors_html = ""
        if open_errors:
            errors_html = "<br>".join([f"• {err}" for err in open_errors])

        extra_html = ""
        if extra_info:
            extra_html = "<br>".join([f"• <strong>{k}:</strong> {v}" for k, v in extra_info.items()])

        return f"""
        <h3 style="color: #ff9800;">Debug Information</h3>
        <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 10px; border-radius: 5px;">
            <table border="0" cellpadding="4" cellspacing="0">
                <tr><td><strong>Open Attempts</strong></td><td>{open_attempts}</td></tr>
                <tr><td><strong>Fully Succeeded</strong></td><td style="color: {'#28a745' if fully_succeeded else '#dc3545'};">{'Yes' if fully_succeeded else 'No'}</td></tr>
            </table>
            {f'<p><strong>Errors:</strong></p><code style="white-space: pre-wrap;">{errors_html}</code>' if errors_html else ''}
            {f'<p><strong>Additional Info:</strong></p><code style="white-space: pre-wrap;">{extra_html}</code>' if extra_html else ''}
        </div>
        """

    def _calculate_price_position_in_range(
        self,
        lower_price: float,
        upper_price: float,
        current_price: float,
    ) -> tuple:
        """
        Calculate where the current price sits within the range.

        Returns:
            tuple: (position_pct, expected_sol_pct, explanation)
                - position_pct: 0% = at lower bound, 100% = at upper bound
                - expected_sol_pct: Expected SOL percentage based on CLMM math
                - explanation: Human-readable explanation
        """
        range_width = upper_price - lower_price
        if range_width <= 0:
            return 50.0, 50.0, "Invalid range"

        # Position in range (0 = lower, 1 = upper)
        position_in_range = (current_price - lower_price) / range_width
        position_pct = position_in_range * 100

        # In CLMM, ratio roughly follows: more USDC as price goes up, more SOL as price goes down
        # This is because as price rises, you're "selling" SOL for USDC
        # Approximate expected SOL% (simplified linear approximation)
        expected_sol_pct = (1 - position_in_range) * 100

        # Generate explanation
        if position_pct < 40:
            explanation = f"Price is in LOWER portion of range ({position_pct:.1f}% up from lower bound) → More SOL, less USDC"
        elif position_pct > 60:
            explanation = f"Price is in UPPER portion of range ({position_pct:.1f}% up from lower bound) → Less SOL, more USDC"
        else:
            explanation = f"Price is near CENTER of range ({position_pct:.1f}% up from lower bound) → Roughly balanced"

        return position_pct, expected_sol_pct, explanation

    def _build_clmm_ratio_explanation_html(
        self,
        lower_price: float,
        upper_price: float,
        current_price: float,
        token_a_ratio: float,
    ) -> str:
        """
        Build HTML section explaining WHY the position has its current SOL/USDC ratio.

        This helps debug whether the ratio is expected behavior or a bug.
        """
        position_pct, expected_sol_pct, explanation = self._calculate_price_position_in_range(
            lower_price, upper_price, current_price
        )

        actual_sol_pct = token_a_ratio * 100
        ratio_diff = abs(actual_sol_pct - expected_sol_pct)

        # Determine if ratio is as expected
        if ratio_diff < 15:
            status = "✅ EXPECTED"
            status_color = "#28a745"
        else:
            status = "⚠️ UNUSUAL"
            status_color = "#ff9800"

        return f"""
        <h3>CLMM Ratio Analysis</h3>
        <div style="background-color: #e3f2fd; border: 1px solid #2196F3; padding: 10px; border-radius: 5px;">
            <p style="margin: 5px 0;"><strong>Why is the ratio {self._format_pct(actual_sol_pct)} SOL / {self._format_pct(100 - actual_sol_pct)} USDC?</strong></p>
            <p style="margin: 5px 0; font-size: 13px; color: #1565C0;"><strong>The ratio is mathematically determined</strong> by where the price sits in your range - you cannot choose it independently.</p>
            <table border="0" cellpadding="4" cellspacing="0">
                <tr><td>Price Position in Range:</td><td><strong>{position_pct:.1f}%</strong> up from lower bound</td></tr>
                <tr><td>Expected SOL %:</td><td>~{expected_sol_pct:.1f}%</td></tr>
                <tr><td>Actual SOL %:</td><td>{actual_sol_pct:.1f}%</td></tr>
                <tr><td>Status:</td><td style="color: {status_color}; font-weight: bold;">{status}</td></tr>
            </table>
            <p style="margin: 5px 0; font-size: 11px; color: #666;"><em>{explanation}</em></p>
        </div>
        """

    def _build_range_calculation_html(
        self,
        price: float,
        atr_pct: float,
        atr_absolute: float,
        k_coefficient: float,
        raw_range_pct: float,
        clamped_range_pct: float,
        min_range_pct: float,
        max_range_pct: float,
        lower_target: float,
        upper_target: float,
        atr_period_days: int = 14,
    ) -> str:
        """
        Build HTML section explaining HOW the price range was calculated.

        Shows the complete calculation from ATR to final range bounds.
        """
        was_clamped = abs(raw_range_pct - clamped_range_pct) > 0.001
        clamp_status = ""
        if raw_range_pct < min_range_pct:
            clamp_status = f"(clamped UP from {raw_range_pct*100:.2f}% to min {min_range_pct*100:.2f}%)"
        elif raw_range_pct > max_range_pct:
            clamp_status = f"(clamped DOWN from {raw_range_pct*100:.2f}% to max {max_range_pct*100:.2f}%)"

        return f"""
        <h3>Range Calculation</h3>
        <div style="background-color: #fff3e0; border: 1px solid #ff9800; padding: 10px; border-radius: 5px;">
            <p style="margin: 5px 0;"><strong>How was the range ${lower_target:.4f} - ${upper_target:.4f} calculated?</strong></p>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 1: ATR Calculation</h4>
            <table border="0" cellpadding="4" cellspacing="0" style="font-size: 12px;">
                <tr><td>ATR Period:</td><td><strong>{atr_period_days} days</strong> (Average True Range)</td></tr>
                <tr><td>ATR (%):</td><td><strong>{atr_pct*100:.2f}%</strong> of price</td></tr>
                <tr><td>ATR ($):</td><td><strong>${atr_absolute:.2f}</strong> absolute volatility</td></tr>
            </table>
            <p style="margin: 5px 0; font-size: 11px; color: #666;">
                ATR measures average daily price volatility over the past {atr_period_days} days.
                Higher ATR = more volatile market = wider range needed.
            </p>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 2: Range Width Formula</h4>
            <div style="background-color: #fff; padding: 8px; border-radius: 3px; font-family: monospace; font-size: 12px;">
                Range Width = K × ATR<br>
                Range Width = {k_coefficient:.2f} × {atr_pct*100:.2f}% = <strong>{raw_range_pct*100:.2f}%</strong>
            </div>
            <p style="margin: 5px 0; font-size: 11px; color: #666;">
                K-coefficient ({k_coefficient:.2f}) determines how aggressively we set ranges.
                K=0.6 means range width is 60% of ATR.
            </p>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 3: Apply Bounds</h4>
            <table border="0" cellpadding="4" cellspacing="0" style="font-size: 12px;">
                <tr><td>Raw Range:</td><td>{raw_range_pct*100:.2f}%</td></tr>
                <tr><td>Min Allowed:</td><td>{min_range_pct*100:.2f}%</td></tr>
                <tr><td>Max Allowed:</td><td>{max_range_pct*100:.2f}%</td></tr>
                <tr><td>Final Range:</td><td><strong>{clamped_range_pct*100:.2f}%</strong> {clamp_status}</td></tr>
            </table>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 4: Calculate Bounds (Target)</h4>
            <div style="background-color: #fff; padding: 8px; border-radius: 3px; font-family: monospace; font-size: 12px;">
                Lower = Price × (1 - Range/2) = ${price:.4f} × (1 - {clamped_range_pct/2:.4f}) = <strong>${lower_target:.4f}</strong><br>
                Upper = Price × (1 + Range/2) = ${price:.4f} × (1 + {clamped_range_pct/2:.4f}) = <strong>${upper_target:.4f}</strong>
            </div>
            <p style="margin: 5px 0; font-size: 11px; color: #666;">
                <em><strong>Note:</strong> Actual position range (shown in Position Details above) may differ slightly.
                CLMM pools use discrete "ticks" as boundaries, so the actual range is snapped to valid tick prices.
                This is normal and typically results in a &lt;1% difference from target.</em>
            </p>
        </div>
        """

    def _build_capital_allocation_html(
        self,
        wallet_sol: float,
        wallet_usdc: float,
        sol_reserve: float,
        available_sol: float,
        available_usdc: float,
        price: float,
        deposited_sol: float,
        deposited_usdc: float,
        deployment_pct: float = 1.0,
        max_sol_per_position: float = 0.0,
        max_usdc_per_position: float = 0.0,
    ) -> str:
        """
        Build HTML section explaining HOW the deposited amounts were determined.

        Shows wallet balances, reserves, caps, and final allocation.
        NOTE: wallet_sol and wallet_usdc are AFTER deposit (remaining balance).
              We reconstruct pre-deposit values by adding back deposited amounts.
        """
        # Reconstruct pre-deposit balances
        pre_deposit_sol = wallet_sol + deposited_sol
        pre_deposit_usdc = wallet_usdc + deposited_usdc
        pre_deposit_total_usd = (pre_deposit_sol * price) + pre_deposit_usdc

        # Available = pre-deposit minus reserve
        pre_available_sol = max(0, pre_deposit_sol - sol_reserve)
        pre_available_usdc = pre_deposit_usdc
        pre_available_total_usd = (pre_available_sol * price) + pre_available_usdc

        deposited_total_usd = (deposited_sol * price) + deposited_usdc
        utilization_pct = (deposited_total_usd / pre_available_total_usd * 100) if pre_available_total_usd > 0 else 0

        return f"""
        <h3>Capital Allocation</h3>
        <div style="background-color: #e8f5e9; border: 1px solid #4caf50; padding: 10px; border-radius: 5px;">
            <p style="margin: 5px 0;"><strong>How were the deposited amounts {deposited_sol:.6f} SOL + ${deposited_usdc:.2f} USDC determined?</strong></p>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 1: Wallet Balances (Before Deposit)</h4>
            <table border="0" cellpadding="4" cellspacing="0" style="font-size: 12px;">
                <tr><td>SOL in Wallet:</td><td>{pre_deposit_sol:.6f} SOL (${pre_deposit_sol * price:.2f})</td></tr>
                <tr><td>USDC in Wallet:</td><td>${pre_deposit_usdc:.2f}</td></tr>
                <tr><td>Total Wallet Value:</td><td><strong>${pre_deposit_total_usd:.2f}</strong></td></tr>
            </table>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 2: Reserve Calculation</h4>
            <table border="0" cellpadding="4" cellspacing="0" style="font-size: 12px;">
                <tr><td>SOL Reserve (for TX fees):</td><td><strong>{sol_reserve:.4f} SOL</strong> (${sol_reserve * price:.2f})</td></tr>
                <tr><td>Available SOL:</td><td>{pre_deposit_sol:.6f} - {sol_reserve:.4f} = <strong>{pre_available_sol:.6f} SOL</strong></td></tr>
                <tr><td>Available USDC:</td><td><strong>${pre_available_usdc:.2f}</strong></td></tr>
                <tr><td>Total Available:</td><td><strong>${pre_available_total_usd:.2f}</strong></td></tr>
            </table>
            <p style="margin: 5px 0; font-size: 11px; color: #666;">
                SOL reserve ensures you always have SOL for transaction fees (~0.000005-0.01 SOL per tx).
            </p>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 3: Position Caps</h4>
            <table border="0" cellpadding="4" cellspacing="0" style="font-size: 12px;">
                <tr><td>Max SOL per Position:</td><td>{max_sol_per_position:.4f} SOL</td></tr>
                <tr><td>Max USDC per Position:</td><td>${max_usdc_per_position:.2f}</td></tr>
                <tr><td>Deployment %:</td><td>{deployment_pct*100:.0f}% of available</td></tr>
            </table>

            <h4 style="margin: 10px 0 5px 0; font-size: 13px;">Step 4: Final Deposit</h4>
            <table border="0" cellpadding="4" cellspacing="0" style="font-size: 12px;">
                <tr><td>Deposited SOL:</td><td><strong>{deposited_sol:.6f} SOL</strong> (${deposited_sol * price:.2f})</td></tr>
                <tr><td>Deposited USDC:</td><td><strong>${deposited_usdc:.2f}</strong></td></tr>
                <tr><td>Total Deposited:</td><td><strong>${deposited_total_usd:.2f}</strong></td></tr>
                <tr><td>Utilization:</td><td>{utilization_pct:.1f}% of available capital</td></tr>
            </table>
            <p style="margin: 5px 0; font-size: 11px; color: #666;">
                The exact amounts deposited depend on the CLMM math - the pool determines how much of each token
                is needed based on your range and the current price position within that range.
            </p>
        </div>
        """

    def _build_strategy_params_html(
        self,
        k_coefficient: float,
        min_range_pct: float,
        max_range_pct: float,
        atr_period_days: int,
        max_rebalances_per_day: int,
        sol_reserve: float,
        deployment_pct: float,
        max_sol_per_position: float,
        max_usdc_per_position: float,
        slippage_bps: int,
    ) -> str:
        """Build HTML section showing all strategy parameters."""
        return f"""
        <h3>Strategy Parameters</h3>
        <div style="background-color: #f5f5f5; border: 1px solid #9e9e9e; padding: 10px; border-radius: 5px;">
            <table border="0" cellpadding="4" cellspacing="0" style="font-size: 12px;">
                <tr><td colspan="2" style="font-weight: bold; border-bottom: 1px solid #ddd;">Range Settings</td></tr>
                <tr><td>K-Coefficient:</td><td>{k_coefficient:.2f} (range = K × ATR)</td></tr>
                <tr><td>Range Bounds:</td><td>{min_range_pct*100:.1f}% - {max_range_pct*100:.1f}%</td></tr>
                <tr><td>ATR Period:</td><td>{atr_period_days} days</td></tr>

                <tr><td colspan="2" style="font-weight: bold; border-bottom: 1px solid #ddd; padding-top: 8px;">Capital Settings</td></tr>
                <tr><td>SOL Reserve:</td><td>{sol_reserve:.4f} SOL (for TX fees)</td></tr>
                <tr><td>Deployment %:</td><td>{deployment_pct*100:.0f}%</td></tr>
                <tr><td>Max SOL/Position:</td><td>{max_sol_per_position:.2f} SOL</td></tr>
                <tr><td>Max USDC/Position:</td><td>${max_usdc_per_position:.2f}</td></tr>

                <tr><td colspan="2" style="font-weight: bold; border-bottom: 1px solid #ddd; padding-top: 8px;">Rebalance Settings</td></tr>
                <tr><td>Max Rebalances/Day:</td><td>{max_rebalances_per_day}</td></tr>
                <tr><td>Slippage Tolerance:</td><td>{slippage_bps} bps ({slippage_bps/100:.2f}%)</td></tr>
            </table>
        </div>
        """

    def _build_position_info_html(
        self,
        position_address: str,
        lower_price: float,
        upper_price: float,
        current_price: float,
        token_a_amount: float,  # SOL
        token_b_amount: float,  # USDC
        is_in_range: bool,
        token_a_ratio: float,
        show_ratio_explanation: bool = True,
    ) -> str:
        """Build HTML section for position information."""
        range_status = "IN RANGE" if is_in_range else "OUT OF RANGE"
        status_color = "#28a745" if is_in_range else "#dc3545"
        position_value = (token_a_amount * current_price) + token_b_amount

        ratio_explanation = ""
        if show_ratio_explanation and is_in_range:
            ratio_explanation = self._build_clmm_ratio_explanation_html(
                lower_price, upper_price, current_price, token_a_ratio
            )

        return f"""
        <h3>Position Details</h3>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
            <tr><td><strong>Position Address</strong></td><td><code>{position_address}</code></td></tr>
            <tr><td><strong>Status</strong></td><td style="color: {status_color}; font-weight: bold;">{range_status}</td></tr>
            <tr><td><strong>Price Range</strong></td><td>{self._format_price(lower_price)} - {self._format_price(upper_price)}</td></tr>
            <tr><td><strong>Current Price</strong></td><td>{self._format_price(current_price)}</td></tr>
            <tr><td><strong>SOL Amount</strong></td><td>{self._format_sol(token_a_amount)}</td></tr>
            <tr><td><strong>USDC Amount</strong></td><td>{self._format_usdc(token_b_amount)}</td></tr>
            <tr><td><strong>Position Value</strong></td><td>${position_value:,.2f}</td></tr>
            <tr><td><strong>Composition</strong></td><td>{self._format_pct(token_a_ratio * 100)} SOL / {self._format_pct((1 - token_a_ratio) * 100)} USDC</td></tr>
        </table>
        {ratio_explanation}
        """

    # ========================================
    # Public notification methods
    # ========================================

    def notify_app_started(
        self,
        session_id: str,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        sol_balance: float,
        usdc_balance: float,
        pool_address: str,
    ) -> bool:
        """Send notification when app starts."""
        self.set_session_id(session_id)

        subject = f"[LP Strategy] App Started - Session {session_id}"

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #2196F3;">LP Strategy v2 - App Started</h2>
            <p><strong>Session ID:</strong> {session_id}</p>
            <p><strong>Started:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>

            {self._build_market_info_html(price, atr_pct, lower_target, upper_target)}
            {self._build_wallet_info_html(sol_balance, usdc_balance, price)}
            {self._build_pool_info_html(pool_address)}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Automated notification</p>
        </body>
        </html>
        """

        text_body = f"""
LP Strategy v2 - App Started

Session ID: {session_id}
Started: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}

Market Data:
- Price: {self._format_price(price)}
- ATR: {self._format_pct_from_decimal(atr_pct)}
- Target Range: {self._format_price(lower_target)} - {self._format_price(upper_target)}

Wallet:
- SOL: {self._format_sol(sol_balance)}
- USDC: {self._format_usdc(usdc_balance)}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=False)

    def notify_position_opened(
        self,
        position_address: str,
        lower_price: float,
        upper_price: float,
        deposited_sol: float,
        deposited_usdc: float,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        sol_balance: float,
        usdc_balance: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
        tick_current: int = 0,
        liquidity: int = 0,
        # Pool debugging parameters
        pool_sqrt_price: int = 0,
        price_source: str = "pool",
        # Range calculation parameters
        atr_absolute: float = 0.0,
        raw_range_pct: float = 0.0,
        clamped_range_pct: float = 0.0,
        # Strategy parameters
        #REVIEW: HARDCODED VALUES. WHY NOT IMPORTING THEM FROM THE REAL CONFIG?
        k_coefficient: float = 0.6,
        min_range_pct: float = 0.03,
        max_range_pct: float = 0.07,
        atr_period_days: int = 14,
        max_rebalances_per_day: int = 2,
        slippage_bps: int = 50,
        # Capital parameters
        sol_reserve: float = 0.1,
        deployment_pct: float = 1.0,
        max_sol_per_position: float = 2.0,
        max_usdc_per_position: float = 300.0,
        available_sol: float = 0.0,
        available_usdc: float = 0.0,
        # Actual cost from balance diff (total and per-operation)
        actual_cost_usd: float = 0.0,
        actual_cost_open_usd: float = 0.0,  # Open operation cost only
        actual_cost_swap_usd: float = 0.0,  # Swap operation cost only (if swap occurred)
        # Entry price (deposit ratio)
        entry_price: float = 0.0,  # Deposit-implied price = deposited_usdc / deposited_sol
    ) -> bool:
        """Send notification when a position is opened."""
        subject = f"[LP Strategy] Position Opened - {position_address}"

        position_value = (deposited_sol * price) + deposited_usdc
        token_a_ratio = (deposited_sol * price) / position_value if position_value > 0 else 0.5

        # Build range calculation section
        range_calc_html = self._build_range_calculation_html(
            price=price,
            atr_pct=atr_pct,
            atr_absolute=atr_absolute if atr_absolute > 0 else atr_pct * price,
            k_coefficient=k_coefficient,
            raw_range_pct=raw_range_pct if raw_range_pct > 0 else k_coefficient * atr_pct,
            clamped_range_pct=clamped_range_pct if clamped_range_pct > 0 else (upper_price - lower_price) / price,
            min_range_pct=min_range_pct,
            max_range_pct=max_range_pct,
            lower_target=lower_target,
            upper_target=upper_target,
            atr_period_days=atr_period_days,
        )

        # Build capital allocation section
        capital_alloc_html = self._build_capital_allocation_html(
            wallet_sol=sol_balance,
            wallet_usdc=usdc_balance,
            sol_reserve=sol_reserve,
            available_sol=available_sol if available_sol > 0 else max(0, sol_balance - sol_reserve),
            available_usdc=available_usdc if available_usdc > 0 else usdc_balance,
            price=price,
            deposited_sol=deposited_sol,
            deposited_usdc=deposited_usdc,
            deployment_pct=deployment_pct,
            max_sol_per_position=max_sol_per_position,
            max_usdc_per_position=max_usdc_per_position,
        )

        # Build strategy params section
        strategy_params_html = self._build_strategy_params_html(
            k_coefficient=k_coefficient,
            min_range_pct=min_range_pct,
            max_range_pct=max_range_pct,
            atr_period_days=atr_period_days,
            max_rebalances_per_day=max_rebalances_per_day,
            sol_reserve=sol_reserve,
            deployment_pct=deployment_pct,
            max_sol_per_position=max_sol_per_position,
            max_usdc_per_position=max_usdc_per_position,
            slippage_bps=slippage_bps,
        )

        # Build actual cost section if available (show per-operation breakdown like rebalance email)
        actual_cost_html = ""
        if actual_cost_usd > 0 or actual_cost_open_usd > 0 or actual_cost_swap_usd > 0:
            cost_rows = []
            if actual_cost_open_usd > 0:
                cost_rows.append(f"<tr><td>&nbsp;&nbsp;Open</td><td>${actual_cost_open_usd:.4f}</td></tr>")
            if actual_cost_swap_usd > 0:
                cost_rows.append(f"<tr><td>&nbsp;&nbsp;Swap (incl. slippage)</td><td>${actual_cost_swap_usd:.4f}</td></tr>")
            cost_rows_html = "\n".join(cost_rows)
            
            actual_cost_html = f"""
            <h3>Transaction Cost</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Actual Cost (Total)</strong></td><td style="color: #dc3545; font-weight: bold;">${actual_cost_usd:.4f}</td></tr>
                {cost_rows_html}
            </table>
            """

        # Build entry price section if available
        entry_price_html = ""
        if entry_price > 0:
            deposited_value_at_entry = (deposited_sol * entry_price) + deposited_usdc
            entry_price_html = f"""
            <h3>Entry Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Entry Price (deposit ratio)</strong></td><td>{self._format_price(entry_price)}</td></tr>
                <tr><td><strong>Current Market Price</strong></td><td>{self._format_price(price)}</td></tr>
                <tr><td><strong>Total Deposited (at market)</strong></td><td>${position_value:,.2f}</td></tr>
                <tr><td><strong>Total Deposited (at entry price)</strong></td><td>${deposited_value_at_entry:,.2f}</td></tr>
            </table>
            """

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #4caf50;">Position Opened</h2>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>

            {self._build_position_info_html(
                position_address, lower_price, upper_price, price,
                deposited_sol, deposited_usdc, True, token_a_ratio,
                show_ratio_explanation=False
            )}

            {actual_cost_html}
            {entry_price_html}
            {range_calc_html}
            {capital_alloc_html}

            {self._build_market_info_html(price, atr_pct, lower_target, upper_target,
                price_source=price_source, pool_sqrt_price=pool_sqrt_price, pool_tick=tick_current)}
            {self._build_wallet_info_html(sol_balance, usdc_balance, price)}
            {self._build_pool_info_html(pool_address, tick_current, liquidity)}
            {self._build_session_info_html(session_state)}

            {strategy_params_html}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Automated notification</p>
        </body>
        </html>
        """

        # Build text body with cost breakdown
        cost_text_parts = []
        if actual_cost_usd > 0:
            cost_text_parts.append(f"Actual Cost (Total): ${actual_cost_usd:.4f}")
        if actual_cost_open_usd > 0:
            cost_text_parts.append(f"  Open: ${actual_cost_open_usd:.4f}")
        if actual_cost_swap_usd > 0:
            cost_text_parts.append(f"  Swap (incl. slippage): ${actual_cost_swap_usd:.4f}")
        actual_cost_text = "\n".join(cost_text_parts) if cost_text_parts else ""
        
        entry_price_text = f"Entry Price (deposit ratio): {self._format_price(entry_price)}" if entry_price > 0 else ""
        text_body = f"""
Position Opened

Position: {position_address}
Range: {self._format_price(lower_price)} - {self._format_price(upper_price)}
Deposited: {self._format_sol(deposited_sol)} + {self._format_usdc(deposited_usdc)}
Price: {self._format_price(price)}
{entry_price_text}
ATR: {atr_pct*100:.2f}% (K={k_coefficient})
{actual_cost_text}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_position_closed(
        self,
        position_address: str,
        lower_price: float,
        upper_price: float,
        withdrawn_sol: float,
        withdrawn_usdc: float,
        fees_collected_sol: float,
        fees_collected_usdc: float,
        close_reason: str,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        sol_balance: float,
        usdc_balance: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
        # New debugging parameters
        tick_current: int = 0,
        pool_sqrt_price: int = 0,
        price_source: str = "pool",
        # Actual close cost from balance diff
        actual_cost_close_usd: float = 0.0,
    ) -> bool:
        """Send notification when a position is closed."""
        subject = f"[LP Strategy] Position Closed ({close_reason}) - {position_address}"

        total_fees = (fees_collected_sol * price) + fees_collected_usdc

        # Calculate position ratio at close
        withdrawn_value = (withdrawn_sol * price) + withdrawn_usdc
        token_a_ratio = (withdrawn_sol * price) / withdrawn_value if withdrawn_value > 0 else 0.5

        # Get ratio explanation
        ratio_explanation = self._build_clmm_ratio_explanation_html(
            lower_price, upper_price, price, token_a_ratio
        ) if lower_price < price < upper_price else ""

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #ff9800;">Position Closed</h2>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
            <p><strong>Reason:</strong> <span style="font-weight: bold;">{close_reason.upper()}</span></p>

            <h3>Closed Position</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Position Address</strong></td><td><code>{position_address}</code></td></tr>
                <tr><td><strong>Price Range</strong></td><td>{self._format_price(lower_price)} - {self._format_price(upper_price)}</td></tr>
                <tr><td><strong>Withdrawn SOL</strong></td><td>{self._format_sol(withdrawn_sol)}</td></tr>
                <tr><td><strong>Withdrawn USDC</strong></td><td>{self._format_usdc(withdrawn_usdc)}</td></tr>
                <tr><td><strong>Withdrawn Value</strong></td><td>${withdrawn_value:,.2f}</td></tr>
                <tr><td><strong>Composition at Close</strong></td><td>{self._format_pct(token_a_ratio * 100)} SOL / {self._format_pct((1 - token_a_ratio) * 100)} USDC</td></tr>
                <tr><td><strong>Fees Collected (SOL)</strong></td><td>{self._format_sol(fees_collected_sol)}</td></tr>
                <tr><td><strong>Fees Collected (USDC)</strong></td><td>{self._format_usdc(fees_collected_usdc)}</td></tr>
                <tr><td><strong>Total Fees (USD)</strong></td><td>${total_fees:,.4f}</td></tr>
            </table>

            {'<h3>Transaction Cost</h3><table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;"><tr><td><strong>Actual Cost (Close)</strong></td><td style="color: #dc3545; font-weight: bold;">$' + f'{actual_cost_close_usd:.4f}' + '</td></tr></table>' if actual_cost_close_usd > 0 else ''}

            {ratio_explanation}
            {self._build_market_info_html(price, atr_pct, lower_target, upper_target,
                price_source=price_source, pool_sqrt_price=pool_sqrt_price, pool_tick=tick_current)}
            {self._build_wallet_info_html(sol_balance, usdc_balance, price)}
            {self._build_pool_info_html(pool_address, tick_current)}
            {self._build_session_info_html(session_state)}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Automated notification</p>
        </body>
        </html>
        """

        actual_cost_close_text = f"Actual Cost (Close): ${actual_cost_close_usd:.4f}" if actual_cost_close_usd > 0 else ""
        text_body = f"""
Position Closed

Position: {position_address}
Reason: {close_reason}
Range: {self._format_price(lower_price)} - {self._format_price(upper_price)}
Withdrawn: {self._format_sol(withdrawn_sol)} + {self._format_usdc(withdrawn_usdc)}
Fees Collected: {self._format_sol(fees_collected_sol)} + {self._format_usdc(fees_collected_usdc)}
Price: {self._format_price(price)}
{actual_cost_close_text}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_rebalance(
        self,
        old_position_address: str,
        new_position_address: Optional[str],
        trigger_reason: str,
        is_emergency: bool,
        price_before: float,
        lower_before: float,
        upper_before: float,
        lower_after: float,
        upper_after: float,
        withdrawn_sol: float,
        withdrawn_usdc: float,
        deposited_sol: float,
        deposited_usdc: float,
        fees_collected_sol: float,
        fees_collected_usdc: float,
        tx_fee_sol: float,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        sol_balance: float,
        usdc_balance: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
        tick_current: int = 0,
        # Debug info for troubleshooting
        open_attempts: int = 1,
        open_errors: Optional[List[str]] = None,
        fully_succeeded: bool = True,
        # New debugging parameters
        pool_sqrt_price: int = 0,
        price_source: str = "pool",
        # Actual cost from balance diff
        actual_cost_usd: float = 0.0,
        actual_cost_close_usd: float = 0.0,
        actual_cost_open_usd: float = 0.0,
        actual_cost_swap_usd: float = 0.0,
        # Entry price for new position (deposit ratio)
        entry_price: float = 0.0,
    ) -> bool:
        """Send notification when a rebalance is executed."""
        emergency_tag = " [EMERGENCY]" if is_emergency else ""

        # Add warning to subject if open failed
        if not fully_succeeded or not new_position_address:
            subject = f"[LP Strategy] ⚠️ Rebalance{emergency_tag} - {trigger_reason} (OPEN FAILED!)"
            status_color = "#dc3545"  # Red for failure
        else:
            subject = f"[LP Strategy] Rebalance{emergency_tag} - {trigger_reason}"
            status_color = "#dc3545" if is_emergency else "#ff9800"

        # Calculate if new position is in range
        is_in_range = lower_after <= price <= upper_after
        new_pos_value = (deposited_sol * price) + deposited_usdc
        token_a_ratio = (deposited_sol * price) / new_pos_value if new_pos_value > 0 else 0.5

        # Calculate old position ratio at close
        old_pos_value = (withdrawn_sol * price) + withdrawn_usdc
        old_token_a_ratio = (withdrawn_sol * price) / old_pos_value if old_pos_value > 0 else 0.5

        # Warning banner if new position wasn't opened
        # CRITICAL FIX: Check if close actually succeeded before saying funds are idle
        # If close failed, the position is still open, so funds are NOT idle
        # Check if close failed by looking for "Close failed" in errors or if nothing was withdrawn
        close_failed = False
        if open_errors:
            close_failed = any("Close failed" in str(err) for err in open_errors)
        # Also check if nothing was withdrawn (indicates close likely failed)
        if not close_failed and withdrawn_sol == 0 and withdrawn_usdc == 0 and open_attempts == 0:
            close_failed = True
        
        warning_banner = ""
        if not new_position_address:
            if close_failed:
                # Close failed - position is still open, funds are NOT idle
                warning_banner = """
                <div style="background-color: #fff3cd; border: 2px solid #ffc107; padding: 15px; border-radius: 5px; margin-bottom: 15px;">
                    <h3 style="color: #856404; margin: 0;">⚠️ WARNING: Rebalance Attempt Failed!</h3>
                    <p style="margin: 5px 0 0 0;"><strong>The rebalance attempt failed to close the position.</strong> The position remains OPEN and funds are NOT idle.</p>
                    <p style="margin: 5px 0 0 0; font-size: 12px; color: #666;">This is normal if the rebalance limit was reached or if there was a transient error. The bot will wait until it can rebalance again.</p>
                </div>
                """
            else:
                # Close succeeded but open failed - funds ARE idle
                warning_banner = """
                <div style="background-color: #f8d7da; border: 2px solid #dc3545; padding: 15px; border-radius: 5px; margin-bottom: 15px;">
                    <h3 style="color: #dc3545; margin: 0;">⚠️ WARNING: New Position NOT Opened!</h3>
                    <p style="margin: 5px 0 0 0;">The old position was closed but a new position could not be opened. Funds are idle in wallet.</p>
                </div>
                """

        # Build ratio explanations for both old and new positions
        old_ratio_explanation = self._build_clmm_ratio_explanation_html(
            lower_before, upper_before, price, old_token_a_ratio
        ) if lower_before < price < upper_before else ""

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: {status_color};">Rebalance Executed{emergency_tag}</h2>
            {warning_banner}
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
            <p><strong>Trigger:</strong> <span style="font-weight: bold;">{trigger_reason.upper()}</span></p>

            <h3>Range Change</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr>
                    <th></th>
                    <th>Before</th>
                    <th>After</th>
                </tr>
                <tr>
                    <td><strong>Lower Bound</strong></td>
                    <td>{self._format_price(lower_before)}</td>
                    <td>{self._format_price(lower_after)}</td>
                </tr>
                <tr>
                    <td><strong>Upper Bound</strong></td>
                    <td>{self._format_price(upper_before)}</td>
                    <td>{self._format_price(upper_after)}</td>
                </tr>
            </table>

            <h3>Transaction Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Old Position</strong></td><td><code>{old_position_address}</code></td></tr>
                <tr><td><strong>New Position</strong></td><td><code style="color: {'inherit' if new_position_address else '#dc3545'};">{new_position_address if new_position_address else 'FAILED - N/A'}</code></td></tr>
                <tr><td><strong>Withdrawn</strong></td><td>{self._format_sol(withdrawn_sol)} + {self._format_usdc(withdrawn_usdc)} ({self._format_pct(old_token_a_ratio * 100)} SOL)</td></tr>
                <tr><td><strong>Deposited</strong></td><td>{self._format_sol(deposited_sol)} + {self._format_usdc(deposited_usdc)} ({self._format_pct(token_a_ratio * 100)} SOL)</td></tr>
                {'<tr><td><strong>Entry Price (deposit ratio)</strong></td><td>' + self._format_price(entry_price) + '</td></tr>' if entry_price > 0 else ''}
                <tr><td><strong>Fees Collected</strong></td><td>{self._format_sol(fees_collected_sol)} + {self._format_usdc(fees_collected_usdc)}</td></tr>
                <tr><td><strong>TX Fee (RPC)</strong></td><td>{self._format_sol(tx_fee_sol)} (${tx_fee_sol * price:.4f})</td></tr>
                <tr><td><strong>Actual Cost (Total)</strong></td><td style="color: #dc3545; font-weight: bold;">${actual_cost_usd:.4f}</td></tr>
                <tr><td>&nbsp;&nbsp;Close</td><td>${actual_cost_close_usd:.4f}</td></tr>
                <tr><td>&nbsp;&nbsp;Open</td><td>${actual_cost_open_usd:.4f}</td></tr>
                <tr><td>&nbsp;&nbsp;Swap (incl. slippage)</td><td>${actual_cost_swap_usd:.4f}</td></tr>
                <tr><td><strong>Open Attempts</strong></td><td>{open_attempts}</td></tr>
            </table>

            {self._build_debug_info_html(open_attempts, open_errors, fully_succeeded)}
            {self._build_position_info_html(
                new_position_address or old_position_address,
                lower_after, upper_after, price,
                deposited_sol, deposited_usdc, is_in_range, token_a_ratio
            ) if new_position_address else ''}
            {self._build_market_info_html(price, atr_pct, lower_target, upper_target,
                price_source=price_source, pool_sqrt_price=pool_sqrt_price, pool_tick=tick_current)}
            {self._build_wallet_info_html(sol_balance, usdc_balance, price)}
            {self._build_pool_info_html(pool_address, tick_current)}
            {self._build_session_info_html(session_state)}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Automated notification</p>
        </body>
        </html>
        """

        text_body = f"""
Rebalance Executed{emergency_tag}

{'⚠️ WARNING: New position NOT opened! Funds are idle in wallet.' if not new_position_address else ''}

Trigger: {trigger_reason}
Old Range: {self._format_price(lower_before)} - {self._format_price(upper_before)}
New Range: {self._format_price(lower_after)} - {self._format_price(upper_after)}
Price: {self._format_price(price)}
Withdrawn: {self._format_sol(withdrawn_sol)} + {self._format_usdc(withdrawn_usdc)}
Deposited: {self._format_sol(deposited_sol)} + {self._format_usdc(deposited_usdc)}
{'Entry Price (deposit ratio): ' + self._format_price(entry_price) if entry_price > 0 else ''}
TX Fee (RPC): {self._format_sol(tx_fee_sol)} (${tx_fee_sol * price:.4f})
Actual Cost (Total): ${actual_cost_usd:.4f}
  Close: ${actual_cost_close_usd:.4f}
  Open: ${actual_cost_open_usd:.4f}
  Swap (incl. slippage): ${actual_cost_swap_usd:.4f}
Open Attempts: {open_attempts}
{'Errors: ' + ', '.join(open_errors) if open_errors else ''}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_swap(
        self,
        direction: str,  # 'sell_sol' or 'buy_sol'
        input_amount: float,
        output_amount: float,
        input_token: str,
        output_token: str,
        reason: str,
        signature: Optional[str],
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        sol_balance: float,
        usdc_balance: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
        tick_current: int = 0,
        liquidity: int = 0,
        tx_fee_sol: float = 0.0,  # Transaction fee in SOL
        actual_cost_usd: float = 0.0,  # Actual cost from balance diff
    ) -> bool:
        """Send notification when a swap is executed on Jupiter."""
        subject = f"[LP Strategy] Swap Executed - {input_token} -> {output_token}"

        # Calculate TX fee in USD
        tx_fee_usd = tx_fee_sol * price

        # Build actual cost display (highlight if significantly higher than RPC fee)
        actual_cost_style = "color: #dc3545; font-weight: bold;" if actual_cost_usd > tx_fee_usd * 2 else ""
        actual_cost_row = f'<tr><td><strong>Actual Cost</strong></td><td style="{actual_cost_style}">${actual_cost_usd:.4f}</td></tr>' if actual_cost_usd > 0 else ""

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #9c27b0;">Swap Executed on Jupiter</h2>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
            <p><strong>Reason:</strong> {reason}</p>

            <h3>Swap Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Direction</strong></td><td>{direction}</td></tr>
                <tr><td><strong>Input</strong></td><td>{input_amount:,.6f} {input_token}</td></tr>
                <tr><td><strong>Output</strong></td><td>{output_amount:,.6f} {output_token}</td></tr>
                <tr><td><strong>Price at Swap</strong></td><td>{self._format_price(price)}</td></tr>
                <tr><td><strong>TX Fee (RPC)</strong></td><td>{tx_fee_sol:.6f} SOL (${tx_fee_usd:.4f})</td></tr>
                {actual_cost_row}
                <tr><td><strong>Signature</strong></td><td><code>{signature[:24] if signature else 'N/A'}...</code></td></tr>
            </table>

            {self._build_market_info_html(price, atr_pct, lower_target, upper_target)}
            {self._build_wallet_info_html(sol_balance, usdc_balance, price)}
            {self._build_pool_info_html(pool_address, tick_current, liquidity)}
            {self._build_session_info_html(session_state)}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Automated notification</p>
        </body>
        </html>
        """

        # Text body with actual cost
        actual_cost_text = f"Actual Cost: ${actual_cost_usd:.4f}" if actual_cost_usd > 0 else ""
        text_body = f"""
Swap Executed on Jupiter

Direction: {direction}
Input: {input_amount:,.6f} {input_token}
Output: {output_amount:,.6f} {output_token}
Reason: {reason}
Price: {self._format_price(price)}
TX Fee (RPC): {tx_fee_sol:.6f} SOL (${tx_fee_usd:.4f})
{actual_cost_text}
Signature: {signature or 'N/A'}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_retry_attempt(
        self,
        operation: str,  # "rebalance" or "recovery"
        attempt_number: int,
        max_attempts: int,
        error_message: str,
        slippage_bps: int,
        next_slippage_bps: int,
        price: float,
        sol_balance: float,
        usdc_balance: float,
        position_address: Optional[str] = None,
    ) -> bool:
        """
        Send notification when a retry attempt is being made.

        This is sent during the retry loop to keep admins informed of
        ongoing attempts to open a position after failure.
        """
        subject = f"[LP Strategy] Retry {attempt_number}/{max_attempts}: {operation.title()} Position Open"

        status_color = "#ff9800" if attempt_number < max_attempts else "#dc3545"
        status_text = "Retrying..." if attempt_number < max_attempts else "Final Attempt"

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: {status_color};">Retry Attempt {attempt_number}/{max_attempts}</h2>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
            <p><strong>Operation:</strong> {operation.title()} Position Open</p>
            <p><strong>Status:</strong> <span style="color: {status_color};">{status_text}</span></p>

            <h3>Retry Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Attempt</strong></td><td>{attempt_number} of {max_attempts}</td></tr>
                <tr><td><strong>Previous Error</strong></td><td style="color: #dc3545;">{error_message}</td></tr>
                <tr><td><strong>Current Slippage</strong></td><td>{slippage_bps} bps ({slippage_bps/100:.1f}%)</td></tr>
                <tr><td><strong>Next Attempt Slippage</strong></td><td>{next_slippage_bps} bps ({next_slippage_bps/100:.1f}%)</td></tr>
            </table>

            <h3>Progressive Slippage Explanation</h3>
            <div style="background-color: #e3f2fd; border: 1px solid #2196F3; padding: 10px; border-radius: 5px;">
                <p style="margin: 5px 0; font-size: 13px;">
                    The system is using <strong>progressive slippage tolerance</strong> to handle market volatility.
                    Each retry attempt allows slightly more price movement to increase success probability.
                </p>
                <p style="margin: 5px 0; font-size: 12px; color: #666;">
                    Schedule: 50 bps → 100 bps → 200 bps → 350 bps (max)
                </p>
            </div>

            <h3>Current Market State</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Price</strong></td><td>{self._format_price(price)}</td></tr>
                <tr><td><strong>Wallet SOL</strong></td><td>{self._format_sol(sol_balance)}</td></tr>
                <tr><td><strong>Wallet USDC</strong></td><td>{self._format_usdc(usdc_balance)}</td></tr>
                <tr><td><strong>Total Value</strong></td><td>${(sol_balance * price) + usdc_balance:,.2f}</td></tr>
            </table>

            {f'<p><strong>Related Position:</strong> <code>{position_address}</code></p>' if position_address else ''}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Retry Notification</p>
        </body>
        </html>
        """

        text_body = f"""
Retry Attempt {attempt_number}/{max_attempts}: {operation.title()} Position Open

Previous Error: {error_message}
Current Slippage: {slippage_bps} bps ({slippage_bps/100:.1f}%)
Next Slippage: {next_slippage_bps} bps ({next_slippage_bps/100:.1f}%)

Market State:
- Price: {self._format_price(price)}
- Wallet: {self._format_sol(sol_balance)} + {self._format_usdc(usdc_balance)}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=False)

    def notify_rebalance_failed(
        self,
        old_position_address: str,
        trigger_reason: str,
        error_messages: List[str],
        open_attempts: int,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        sol_balance: float,
        usdc_balance: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
        close_succeeded: bool = False,
        withdrawn_sol: float = 0.0,
        withdrawn_usdc: float = 0.0,
        final_slippage_bps: int = 0,
    ) -> bool:
        """
        Send CRITICAL notification when a rebalance fails to open new position.

        This is a high-priority alert indicating the bot has no active position
        and funds are sitting idle in the wallet.
        """
        subject = f"[LP Strategy] ⚠️ CRITICAL: Rebalance Failed - No Position Open!"

        errors_html = "<br>".join([f"• {err}" for err in error_messages]) if error_messages else "No errors recorded"

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #dc3545;">⚠️ CRITICAL: Rebalance Failed</h2>
            <p style="font-size: 16px; color: #dc3545;"><strong>The bot closed the old position but FAILED to open a new one!</strong></p>
            <p style="font-size: 14px; color: #666;">Funds are sitting idle in the wallet. Manual intervention may be required.</p>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>

            <h3>Failure Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Old Position</strong></td><td><code>{old_position_address}</code></td></tr>
                <tr><td><strong>Trigger Reason</strong></td><td>{trigger_reason.upper()}</td></tr>
                <tr><td><strong>Close Succeeded</strong></td><td style="color: {'#28a745' if close_succeeded else '#dc3545'};">{'Yes' if close_succeeded else 'No'}</td></tr>
                <tr><td><strong>Open Attempts</strong></td><td>{open_attempts}</td></tr>
                <tr><td><strong>Final Slippage Used</strong></td><td>{final_slippage_bps} bps ({final_slippage_bps/100:.1f}%)</td></tr>
                <tr><td><strong>New Position Opened</strong></td><td style="color: #dc3545; font-weight: bold;">NO</td></tr>
            </table>

            <h3>Progressive Slippage Used</h3>
            <div style="background-color: #e3f2fd; border: 1px solid #2196F3; padding: 10px; border-radius: 5px;">
                <p style="margin: 5px 0; font-size: 13px;">
                    The system used <strong>progressive slippage tolerance</strong> across {open_attempts} attempts,
                    reaching a maximum of {final_slippage_bps} bps ({final_slippage_bps/100:.1f}%) on the final attempt.
                </p>
                <p style="margin: 5px 0; font-size: 12px; color: #666;">
                    Schedule: 50 bps → 100 bps → 200 bps → 350 bps (max)
                </p>
                <p style="margin: 5px 0; font-size: 12px; color: #dc3545;">
                    Despite progressive slippage, all {open_attempts} attempts failed. This may indicate severe market
                    volatility, insufficient liquidity, or other issues requiring manual intervention.
                </p>
            </div>

            <h3>Error Messages</h3>
            <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 10px; border-radius: 5px;">
                <code style="white-space: pre-wrap;">{errors_html}</code>
            </div>

            <h3>Funds Status (in wallet, not in position)</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Withdrawn from closed position</strong></td><td>{self._format_sol(withdrawn_sol)} + {self._format_usdc(withdrawn_usdc)}</td></tr>
                <tr><td><strong>Current Wallet SOL</strong></td><td>{self._format_sol(sol_balance)}</td></tr>
                <tr><td><strong>Current Wallet USDC</strong></td><td>{self._format_usdc(usdc_balance)}</td></tr>
                <tr><td><strong>Total Value (USD)</strong></td><td>${(sol_balance * price) + usdc_balance:,.2f}</td></tr>
            </table>

            {self._build_market_info_html(price, atr_pct, lower_target, upper_target)}
            {self._build_pool_info_html(pool_address)}
            {self._build_session_info_html(session_state)}

            <h3 style="color: #dc3545;">Recommended Actions</h3>
            <ol>
                <li>Check the Fly.io logs for detailed error messages</li>
                <li>Verify wallet has sufficient SOL for tx fees (need ~0.05 SOL reserve)</li>
                <li>Check if the pool is still active and has liquidity</li>
                <li>The bot will attempt to recover on the next iteration</li>
                <li>If recovery fails repeatedly, consider manual intervention</li>
            </ol>

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - CRITICAL ALERT</p>
        </body>
        </html>
        """

        text_body = f"""
⚠️ CRITICAL: Rebalance Failed - No Position Open!

The bot closed the old position but FAILED to open a new one!
Funds are sitting idle in the wallet.

Old Position: {old_position_address}
Trigger: {trigger_reason}
Open Attempts: {open_attempts}

Errors:
{chr(10).join(error_messages) if error_messages else 'No errors recorded'}

Wallet Balance:
- SOL: {self._format_sol(sol_balance)}
- USDC: {self._format_usdc(usdc_balance)}

Price: {self._format_price(price)}

The bot will attempt to recover on the next iteration.
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_position_recovery(
        self,
        position_address: str,
        lower_price: float,
        upper_price: float,
        deposited_sol: float,
        deposited_usdc: float,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        sol_balance: float,
        usdc_balance: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
        recovery_reason: str = "no_active_position",
        # New debugging parameters
        tick_current: int = 0,
        pool_sqrt_price: int = 0,
        price_source: str = "pool",
        # Recovery attempt tracking
        recovery_attempt: int = 0,
        max_recovery_attempts: int = 5,
        final_slippage_bps: int = 0,
    ) -> bool:
        """
        Send notification when bot successfully recovers by opening a new position
        after a previous failure.
        """
        subject = f"[LP Strategy] ✅ Recovery Successful - Position Opened"

        position_value = (deposited_sol * price) + deposited_usdc
        token_a_ratio = (deposited_sol * price) / position_value if position_value > 0 else 0.5

        # Build recovery details section
        recovery_details_html = ""
        if recovery_attempt > 0 or final_slippage_bps > 0:
            recovery_details_html = f"""
            <h3>Recovery Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Recovery Attempt</strong></td><td>{recovery_attempt} of {max_recovery_attempts}</td></tr>
                <tr><td><strong>Slippage Used</strong></td><td>{final_slippage_bps} bps ({final_slippage_bps/100:.1f}%)</td></tr>
            </table>
            <div style="background-color: #e8f5e9; border: 1px solid #4caf50; padding: 10px; border-radius: 5px; margin-top: 10px;">
                <p style="margin: 5px 0; font-size: 13px;">
                    The bot used <strong>progressive slippage tolerance</strong> with cross-iteration recovery
                    to successfully open this position after previous failures.
                </p>
            </div>
            """

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #28a745;">✅ Recovery Successful</h2>
            <p><strong>The bot successfully recovered and opened a new position.</strong></p>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
            <p><strong>Recovery Reason:</strong> {recovery_reason}</p>

            {recovery_details_html}

            {self._build_position_info_html(
                position_address, lower_price, upper_price, price,
                deposited_sol, deposited_usdc, True, token_a_ratio
            )}
            {self._build_market_info_html(price, atr_pct, lower_target, upper_target,
                price_source=price_source, pool_sqrt_price=pool_sqrt_price, pool_tick=tick_current)}
            {self._build_wallet_info_html(sol_balance, usdc_balance, price)}
            {self._build_pool_info_html(pool_address, tick_current)}
            {self._build_session_info_html(session_state)}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Recovery notification</p>
        </body>
        </html>
        """

        text_body = f"""
✅ Recovery Successful - Position Opened

The bot successfully recovered and opened a new position.

Recovery Attempt: {recovery_attempt} of {max_recovery_attempts}
Slippage Used: {final_slippage_bps} bps ({final_slippage_bps/100:.1f}%)

Position: {position_address}
Range: {self._format_price(lower_price)} - {self._format_price(upper_price)}
Deposited: {self._format_sol(deposited_sol)} + {self._format_usdc(deposited_usdc)}
Price: {self._format_price(price)}
Recovery Reason: {recovery_reason}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_session_ended(
        self,
        session_id: str,
        end_reason: str,  # 'duration_limit', 'manual_stop', 'error', etc.
        duration_hours: float,
        total_rebalances: int,
        emergency_rebalances: int,
        initial_value_usd: float,
        final_value_usd: float,
        net_pnl_usd: float,
        net_pnl_pct: float,
        total_fees_collected_usd: float,
        price_at_start: float,
        price_at_end: float,
        position_closed: bool,
        position_address: Optional[str] = None,
        final_sol_balance: float = 0.0,
        final_usdc_balance: float = 0.0,
        # New metrics from session_manager
        total_deployed_capital_usd: float = 0.0,
        currently_deployed_usd: float = 0.0,
        session_pnl_pct_deployed: float = 0.0,
        session_pnl_pct_initial: float = 0.0,
        realized_pnl_usd: float = 0.0,
        unrealized_pnl_usd: float = 0.0,
        positions_opened: int = 0,
        positions_closed: int = 0,
        # Strategy performance metrics (LP vs HODL)
        strategy_alpha_usd: float = 0.0,
        strategy_alpha_pct: float = 0.0,
        total_market_movement_usd: float = 0.0,
        total_il_usd: float = 0.0,
        total_tx_costs_usd: float = 0.0,
        lp_beat_hodl: bool = True,
    ) -> bool:
        """
        Send notification when session ends (duration limit, manual stop, or error).

        Includes full session summary and CSV attachments.
        """
        # Determine subject based on end reason
        reason_labels = {
            'duration_limit': 'Duration Limit Reached',
            'manual_stop': 'Manual Stop',
            'error': 'Error',
            'shutdown': 'Shutdown',
        }
        reason_label = reason_labels.get(end_reason, end_reason.replace('_', ' ').title())

        subject = f"[LP Strategy] Session Ended ({reason_label}) - {session_id}"

        # Format duration
        if duration_hours < 1:
            duration_str = f"{duration_hours * 60:.0f} minutes"
        elif duration_hours < 24:
            duration_str = f"{duration_hours:.1f} hours"
        else:
            days = duration_hours / 24
            duration_str = f"{days:.2f} days ({duration_hours:.1f} hours)"

        # Price change
        price_change_pct = ((price_at_end - price_at_start) / price_at_start * 100) if price_at_start > 0 else 0
        price_change_color = "#28a745" if price_change_pct >= 0 else "#dc3545"

        # PnL color
        pnl_color = "#28a745" if net_pnl_usd >= 0 else "#dc3545"

        # Position status (NO TRUNCATION)
        if position_closed:
            position_status = '<span style="color: #28a745;">✅ Closed (funds in wallet)</span>'
        elif position_address:
            position_status = f'<span style="color: #ff9800;">⚠️ Still Open: <code>{position_address}</code></span>'
        else:
            position_status = '<span style="color: #666;">No position</span>'

        # Total wallet value
        total_wallet_value = (final_sol_balance * price_at_end) + final_usdc_balance

        # Color for realized/unrealized
        realized_color = "#28a745" if realized_pnl_usd >= 0 else "#dc3545"
        unrealized_color = "#28a745" if unrealized_pnl_usd >= 0 else "#dc3545"

        # Colors for strategy metrics
        alpha_color = "#28a745" if strategy_alpha_usd >= 0 else "#dc3545"
        market_color = "#28a745" if total_market_movement_usd >= 0 else "#dc3545"
        il_color = "#28a745" if total_il_usd >= 0 else "#dc3545"
        alpha_label = "outperformed" if lp_beat_hodl else "underperformed"

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #9c27b0;">Session Ended - {reason_label}</h2>
            <p><strong>Session ID:</strong> {session_id}</p>
            <p><strong>Ended:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>
            <p><strong>Reason:</strong> {reason_label}</p>

            <h3>Session Summary</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Duration</strong></td><td>{duration_str}</td></tr>
                <tr><td><strong>Positions Opened</strong></td><td>{positions_opened}</td></tr>
                <tr><td><strong>Positions Closed</strong></td><td>{positions_closed}</td></tr>
                <tr><td><strong>Total Rebalances</strong></td><td>{total_rebalances}</td></tr>
                <tr><td><strong>Emergency Rebalances</strong></td><td>{emergency_rebalances}</td></tr>
            </table>

            <h3>Capital Deployment</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Initial Wallet Balance</strong></td><td>${initial_value_usd:,.2f}</td></tr>
                <tr><td><strong>Total Deployed (Cumulative)</strong></td><td>${total_deployed_capital_usd:,.2f}</td></tr>
                <tr><td><strong>Currently Deployed</strong></td><td>${currently_deployed_usd:,.2f}</td></tr>
            </table>

            <h3>Performance (CORRECT Position-Based Calculation)</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Session PnL</strong></td><td style="color: {pnl_color}; font-weight: bold;">${net_pnl_usd:,.2f}</td></tr>
                <tr><td><strong>Realized PnL</strong></td><td style="color: {realized_color};">${realized_pnl_usd:,.2f}</td></tr>
                <tr><td><strong>Unrealized PnL</strong></td><td style="color: {unrealized_color};">${unrealized_pnl_usd:,.2f}</td></tr>
                <tr><td><strong>Total Fees Collected</strong></td><td>${total_fees_collected_usd:,.2f}</td></tr>
                <tr><td><strong>Return on Currently Deployed</strong></td><td style="color: {pnl_color}; font-weight: bold;">{session_pnl_pct_deployed:+.2f}%</td></tr>
                <tr><td><strong>Return on Initial Wallet</strong></td><td style="color: {pnl_color}; font-weight: bold;">{session_pnl_pct_initial:+.2f}%</td></tr>
            </table>

            <h3>Strategy Performance (LP vs HODL)</h3>
            <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
                Alpha = Fees + IL - TX Costs (positive IL means profit, negative means loss)
            </p>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Market Movement</strong></td><td style="color: {market_color};">${total_market_movement_usd:+,.2f} (HODL would have returned)</td></tr>
                <tr><td><strong>Impermanent Loss (IL)</strong></td><td style="color: {il_color};">${total_il_usd:+,.2f}</td></tr>
                <tr><td><strong>TX Costs</strong></td><td style="color: #dc3545;">${total_tx_costs_usd:,.2f}</td></tr>
                <tr style="background-color: #f8f9fa;"><td><strong>Strategy Alpha</strong></td><td style="color: {alpha_color}; font-weight: bold;">${strategy_alpha_usd:+,.2f} ({strategy_alpha_pct:+.2f}%)</td></tr>
                <tr style="background-color: #e8f5e9;"><td><strong>Result</strong></td><td style="color: {alpha_color}; font-weight: bold;">LP {alpha_label} HODL by ${abs(strategy_alpha_usd):,.2f}</td></tr>
            </table>

            <h3>Price Movement</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Price at Start</strong></td><td>{self._format_price(price_at_start)}</td></tr>
                <tr><td><strong>Price at End</strong></td><td>{self._format_price(price_at_end)}</td></tr>
                <tr><td><strong>Price Change</strong></td><td style="color: {price_change_color};">{price_change_pct:+.2f}%</td></tr>
            </table>

            <h3>Final State</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Position Status</strong></td><td>{position_status}</td></tr>
                <tr><td><strong>SOL Balance</strong></td><td>{self._format_sol(final_sol_balance)}</td></tr>
                <tr><td><strong>USDC Balance</strong></td><td>{self._format_usdc(final_usdc_balance)}</td></tr>
                <tr><td><strong>Total Wallet Value</strong></td><td>${total_wallet_value:,.2f}</td></tr>
            </table>

            <h3>Attached Files</h3>
            <p>The following CSV files are attached to this email:</p>
            <ul>
                <li><strong>lp_management.csv</strong> - Position lifecycle and performance data</li>
                <li><strong>asset_fees_management.csv</strong> - All swaps and fee collections</li>
                <li><strong>pool_state_history.csv</strong> - Pool state at each iteration</li>
            </ul>

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Session End notification</p>
        </body>
        </html>
        """

        text_body = f"""
Session Ended - {reason_label}

Session ID: {session_id}
Ended: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}
Reason: {reason_label}

Session Summary:
- Duration: {duration_str}
- Positions Opened: {positions_opened}
- Positions Closed: {positions_closed}
- Total Rebalances: {total_rebalances}
- Emergency Rebalances: {emergency_rebalances}

Capital Deployment:
- Initial Wallet Balance: ${initial_value_usd:,.2f}
- Total Deployed (Cumulative): ${total_deployed_capital_usd:,.2f}
- Currently Deployed: ${currently_deployed_usd:,.2f}

Performance (CORRECT Position-Based Calculation):
- Session PnL: ${net_pnl_usd:,.2f}
- Realized PnL: ${realized_pnl_usd:,.2f}
- Unrealized PnL: ${unrealized_pnl_usd:,.2f}
- Total Fees Collected: ${total_fees_collected_usd:,.2f}
- Return on Currently Deployed: {session_pnl_pct_deployed:+.2f}%
- Return on Initial Wallet: {session_pnl_pct_initial:+.2f}%

Strategy Performance (LP vs HODL):
Alpha = Fees + IL - TX Costs
- Market Movement: ${total_market_movement_usd:+,.2f} (HODL would have returned)
- Impermanent Loss (IL): ${total_il_usd:+,.2f}
- TX Costs: ${total_tx_costs_usd:,.2f}
- Strategy Alpha: ${strategy_alpha_usd:+,.2f} ({strategy_alpha_pct:+.2f}%)
- Result: LP {alpha_label} HODL by ${abs(strategy_alpha_usd):,.2f}

Price Movement:
- Price at Start: {self._format_price(price_at_start)}
- Price at End: {self._format_price(price_at_end)}
- Price Change: {price_change_pct:+.2f}%

Final State:
- Position Status: {'Closed' if position_closed else f'Still Open: {position_address}' if position_address else 'No position'}
- SOL Balance: {self._format_sol(final_sol_balance)}
- USDC Balance: {self._format_usdc(final_usdc_balance)}
- Total Wallet Value: ${total_wallet_value:,.2f}

CSV files are attached to this email.
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_critical_failure(
        self,
        failure_type: str,  # "SWAP_FAILURE" or "CAPITAL_DEPLOYMENT" or "POSITION_BLOCKED"
        error_details: Dict[str, Any],
        sol_balance: float,
        usdc_balance: float,
        price: float,
    ) -> bool:
        """
        Send CRITICAL failure notification for issues that prevent rebalancing.

        This is sent when:
        1. Swap fails after multiple retries (prevents proper token balance)
        2. Capital deployment is severely reduced (<50% of target)
        3. Position opening is blocked due to token imbalance

        Args:
            failure_type: Type of failure
            error_details: Dict with specific error information
            sol_balance: Current SOL balance
            usdc_balance: Current USDC balance
            price: Current SOL/USDC price
        """
        if not self.is_enabled:
            return False

        subject = f"🚨 CRITICAL FAILURE - {failure_type} - LP Strategy"

        # Build error-specific details
        if failure_type == "SWAP_FAILURE":
            failure_description = "Token swap failed after multiple retry attempts"
            details_html = f"""
            <h3 style="color: #dc3545;">Swap Failure Details</h3>
            <ul>
                <li><strong>Initial Swap Error:</strong> {error_details.get('initial_error', 'Unknown')}</li>
                <li><strong>Retry Attempt:</strong> {error_details.get('retry_attempted', False)}</li>
                <li><strong>Retry Slippage:</strong> {error_details.get('retry_slippage_bps', 0)} bps</li>
                <li><strong>Retry Error:</strong> {error_details.get('retry_error', 'N/A')}</li>
                <li><strong>Token Imbalance:</strong> {error_details.get('sol_pct', 0)*100:.1f}% SOL / {error_details.get('usdc_pct', 0)*100:.1f}% USDC</li>
            </ul>
            """
        elif failure_type == "CAPITAL_DEPLOYMENT":
            failure_description = "Capital deployment severely reduced due to token imbalance"
            details_html = f"""
            <h3 style="color: #dc3545;">Capital Deployment Issue</h3>
            <ul>
                <li><strong>Total Available Capital:</strong> ${error_details.get('total_available', 0):,.2f}</li>
                <li><strong>Expected Deployment (95%):</strong> ${error_details.get('expected_deployment', 0):,.2f}</li>
                <li><strong>Actual Deployment:</strong> ${error_details.get('actual_deployment', 0):,.2f}</li>
                <li><strong>Deployment Ratio:</strong> {error_details.get('deployment_ratio', 0)*100:.1f}%</li>
                <li><strong>Capital Wasted:</strong> ${error_details.get('capital_wasted', 0):,.2f}</li>
                <li><strong>Swap Status:</strong> {'Executed' if error_details.get('swap_executed') else 'Failed' if error_details.get('swap_failed') else 'Not Attempted'}</li>
                {f"<li><strong>Swap Error:</strong> {error_details.get('swap_error')}</li>" if error_details.get('swap_error') else ''}
            </ul>
            """
        elif failure_type == "POSITION_BLOCKED":
            failure_description = "Position opening blocked to prevent capital waste"
            details_html = f"""
            <h3 style="color: #dc3545;">Position Opening Blocked</h3>
            <ul>
                <li><strong>Reason:</strong> {error_details.get('reason', 'Unknown')}</li>
                <li><strong>Token Imbalance:</strong> {error_details.get('sol_pct', 0)*100:.1f}% SOL / {(1-error_details.get('sol_pct', 0.5))*100:.1f}% USDC</li>
                <li><strong>Threshold Exceeded:</strong> {error_details.get('threshold_exceeded', 'Unknown')}</li>
                <li><strong>Swap Retry Attempted:</strong> {'Yes' if error_details.get('retry_attempted') else 'No'}</li>
            </ul>
            """
        else:
            failure_description = "Unknown critical failure"
            details_html = "<p>No specific details available</p>"

        total_value = (sol_balance * price) + usdc_balance
        sol_pct = (sol_balance * price) / total_value if total_value > 0 else 0.5

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <div style="background-color: #f8d7da; border: 3px solid #dc3545; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
                <h1 style="color: #721c24; margin: 0;">🚨 CRITICAL FAILURE ALERT 🚨</h1>
                <h2 style="color: #721c24; margin: 10px 0 0 0;">{failure_type}</h2>
            </div>

            <p style="font-size: 16px; color: #721c24;"><strong>{failure_description}</strong></p>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>

            {details_html}

            <h3>Current Wallet State</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr>
                    <th>Asset</th>
                    <th>Amount</th>
                    <th>Value (USD)</th>
                    <th>% of Total</th>
                </tr>
                <tr>
                    <td>SOL</td>
                    <td>{sol_balance:.4f} SOL</td>
                    <td>${sol_balance * price:,.2f}</td>
                    <td>{sol_pct*100:.1f}%</td>
                </tr>
                <tr>
                    <td>USDC</td>
                    <td>${usdc_balance:,.2f}</td>
                    <td>${usdc_balance:,.2f}</td>
                    <td>{(1-sol_pct)*100:.1f}%</td>
                </tr>
                <tr style="font-weight: bold; background-color: #f8f9fa;">
                    <td>TOTAL</td>
                    <td>-</td>
                    <td>${total_value:,.2f}</td>
                    <td>100%</td>
                </tr>
            </table>

            <h3 style="color: #dc3545;">⚠️ ACTION REQUIRED</h3>
            <div style="background-color: #fff3cd; border: 2px solid #ffc107; padding: 15px; border-radius: 5px;">
                <p style="margin: 0;"><strong>This failure prevents normal operations. Investigate immediately:</strong></p>
                <ol style="margin: 10px 0 0 0;">
                    <li>Check fly.io logs for detailed error messages: <code>flyctl logs --app lp-strategy-v2</code></li>
                    <li>Verify Solana RPC is operational</li>
                    <li>Check Jupiter swap liquidity</li>
                    <li>Consider manual intervention if issue persists</li>
                </ol>
            </div>

            <p style="margin-top: 30px; color: #666; font-size: 12px;">
                This is an automated critical failure notification from LP Strategy v2.<br>
                These emails are sent ONLY for failures that prevent rebalancing and may result in capital loss.
            </p>
        </body>
        </html>
        """

        text_body = f"""
🚨 CRITICAL FAILURE ALERT - {failure_type}

{failure_description}

Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}

Error Details:
{chr(10).join(f"- {k}: {v}" for k, v in error_details.items())}

Current Wallet State:
- SOL: {sol_balance:.4f} (${sol_balance * price:,.2f}) = {sol_pct*100:.1f}%
- USDC: ${usdc_balance:,.2f} = {(1-sol_pct)*100:.1f}%
- Total: ${total_value:,.2f}

⚠️ ACTION REQUIRED:
This failure prevents normal operations. Investigate immediately.

1. Check fly.io logs: flyctl logs --app lp-strategy-v2
2. Verify Solana RPC status
3. Check Jupiter swap liquidity
4. Consider manual intervention if issue persists
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=False)

    def notify_recovery_exhausted(
        self,
        recovery_reason: str,
        recovery_attempts: int,
        max_recovery_attempts: int,
        sol_balance: float,
        usdc_balance: float,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Send CRITICAL notification when position recovery attempts are exhausted.

        This is sent when the bot has tried max_recovery_attempts times to open
        a new position after a failure, and all attempts have failed.
        The system is now stuck with idle funds.
        """
        subject = f"[LP Strategy] 🚨 CRITICAL: Recovery Exhausted - Manual Intervention Required!"

        total_value = (sol_balance * price) + usdc_balance

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <div style="background-color: #f8d7da; border: 3px solid #dc3545; padding: 20px; border-radius: 10px; margin-bottom: 20px;">
                <h1 style="color: #721c24; margin: 0;">🚨 RECOVERY EXHAUSTED 🚨</h1>
                <h2 style="color: #721c24; margin: 10px 0 0 0;">Manual Intervention Required</h2>
            </div>

            <p style="font-size: 16px; color: #dc3545;"><strong>
                The bot has exhausted all {max_recovery_attempts} recovery attempts and cannot open a new position.
                Funds are sitting idle in the wallet.
            </strong></p>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>

            <h3>Recovery Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Recovery Reason</strong></td><td>{recovery_reason}</td></tr>
                <tr><td><strong>Attempts Made</strong></td><td style="color: #dc3545; font-weight: bold;">{recovery_attempts} of {max_recovery_attempts}</td></tr>
                <tr><td><strong>Status</strong></td><td style="color: #dc3545; font-weight: bold;">ALL ATTEMPTS FAILED</td></tr>
            </table>

            <h3>Idle Funds (in wallet, NOT in position)</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>SOL Balance</strong></td><td>{self._format_sol(sol_balance)}</td></tr>
                <tr><td><strong>USDC Balance</strong></td><td>{self._format_usdc(usdc_balance)}</td></tr>
                <tr><td><strong>Total Value (USD)</strong></td><td style="font-weight: bold;">${total_value:,.2f}</td></tr>
            </table>

            {self._build_market_info_html(price, atr_pct, lower_target, upper_target)}
            {self._build_pool_info_html(pool_address)}
            {self._build_session_info_html(session_state)}

            <h3 style="color: #dc3545;">⚠️ IMMEDIATE ACTION REQUIRED</h3>
            <div style="background-color: #f8d7da; border: 2px solid #dc3545; padding: 15px; border-radius: 5px;">
                <p style="margin: 0;"><strong>The bot will NOT automatically retry. Manual intervention is required:</strong></p>
                <ol style="margin: 10px 0 0 0;">
                    <li><strong>Restart the app</strong> to reset recovery counters and retry:<br>
                        <code style="background: #fff; padding: 3px 6px;">flyctl apps restart lp-strategy-v2-instance2</code></li>
                    <li>Check fly.io logs for detailed error messages:<br>
                        <code style="background: #fff; padding: 3px 6px;">flyctl logs -a lp-strategy-v2-instance2</code></li>
                    <li>Verify Solana RPC is operational</li>
                    <li>Check if the pool is still active and has liquidity</li>
                    <li>Ensure wallet has sufficient SOL for transaction fees (need ~0.05 SOL reserve)</li>
                </ol>
            </div>

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - CRITICAL ALERT</p>
        </body>
        </html>
        """

        text_body = f"""
🚨 CRITICAL: Recovery Exhausted - Manual Intervention Required!

The bot has exhausted all {max_recovery_attempts} recovery attempts and cannot open a new position.
Funds are sitting idle in the wallet.

Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}

Recovery Details:
- Reason: {recovery_reason}
- Attempts Made: {recovery_attempts} of {max_recovery_attempts}
- Status: ALL ATTEMPTS FAILED

Idle Funds:
- SOL: {self._format_sol(sol_balance)}
- USDC: {self._format_usdc(usdc_balance)}
- Total: ${total_value:,.2f}

Price: {self._format_price(price)}

⚠️ IMMEDIATE ACTION REQUIRED:
The bot will NOT automatically retry. Manual intervention is required.

1. Restart the app: flyctl apps restart lp-strategy-v2-instance2
2. Check logs: flyctl logs -a lp-strategy-v2-instance2
3. Verify RPC and pool status
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_position_open_failed(
        self,
        error: str,
        context: str,  # "initial" or "recovery"
        sol_balance: float,
        usdc_balance: float,
        price: float,
        atr_pct: float,
        lower_target: float,
        upper_target: float,
        pool_address: str,
        session_state: Optional[Dict[str, Any]] = None,
        recovery_scheduled: bool = True,
        recovery_attempts: int = 0,
        max_recovery_attempts: int = 8,
    ) -> bool:
        """
        Send notification when position opening fails.

        This is sent when:
        1. Initial position open fails after app startup
        2. Recovery position open fails (but recovery will be retried)
        """
        context_label = "Initial Position Open" if context == "initial" else "Position Recovery"
        subject = f"[LP Strategy] ⚠️ {context_label} Failed - Recovery Scheduled"

        total_value = (sol_balance * price) + usdc_balance

        recovery_status_html = ""
        if recovery_scheduled:
            remaining = max_recovery_attempts - recovery_attempts
            recovery_status_html = f"""
            <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 10px; border-radius: 5px; margin-top: 15px;">
                <p style="margin: 5px 0;"><strong>🔄 Recovery Scheduled</strong></p>
                <p style="margin: 5px 0; font-size: 13px;">
                    The bot will automatically attempt to open a new position on the next iteration.
                </p>
                <p style="margin: 5px 0; font-size: 12px; color: #666;">
                    Recovery attempts remaining: <strong>{remaining}</strong> of {max_recovery_attempts}
                </p>
            </div>
            """

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #ff9800;">⚠️ {context_label} Failed</h2>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>

            <h3>Failure Details</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>Context</strong></td><td>{context_label}</td></tr>
                <tr><td><strong>Error</strong></td><td style="color: #dc3545;">{error}</td></tr>
                <tr><td><strong>Position Opened</strong></td><td style="color: #dc3545; font-weight: bold;">NO</td></tr>
            </table>

            {recovery_status_html}

            <h3>Wallet Balances (idle, not in position)</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
                <tr><td><strong>SOL Balance</strong></td><td>{self._format_sol(sol_balance)}</td></tr>
                <tr><td><strong>USDC Balance</strong></td><td>{self._format_usdc(usdc_balance)}</td></tr>
                <tr><td><strong>Total Value (USD)</strong></td><td>${total_value:,.2f}</td></tr>
            </table>

            {self._build_market_info_html(price, atr_pct, lower_target, upper_target)}
            {self._build_pool_info_html(pool_address)}
            {self._build_session_info_html(session_state)}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Position Open Failed notification</p>
        </body>
        </html>
        """

        text_body = f"""
⚠️ {context_label} Failed

Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}

Error: {error}

Recovery Status: {'Scheduled' if recovery_scheduled else 'Not Scheduled'}
Recovery Attempts Remaining: {max_recovery_attempts - recovery_attempts} of {max_recovery_attempts}

Wallet Balances:
- SOL: {self._format_sol(sol_balance)}
- USDC: {self._format_usdc(usdc_balance)}
- Total: ${total_value:,.2f}

Price: {self._format_price(price)}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)

    def notify_position_lost(
        self,
        position_address: str,
        reason: str,
        details: str,
        price: float = 0.0,
        session_state: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """
        Send notification when a position is unexpectedly lost or removed.

        This is a CRITICAL notification sent when:
        1. Position snapshot returns None (position may not exist on-chain)
        2. Monitor initialization fails after rebalance
        3. Position cannot be verified after opening

        This notification ensures the user is always informed when a position
        is silently removed from tracking, which was previously a gap in the
        notification system.
        """
        # Map reason codes to human-readable labels
        reason_labels = {
            "snapshot_failed": "Snapshot Query Failed",
            "monitor_init_failed": "Monitor Initialization Failed",
            "verification_failed": "Position Verification Failed",
        }
        reason_label = reason_labels.get(reason, reason)

        subject = f"[LP Strategy] CRITICAL: Position Lost - {reason_label}"

        html_body = f"""
        <html>
        <body style="font-family: Arial, sans-serif;">
            <h2 style="color: #dc3545;">CRITICAL: Position Lost</h2>
            <p><strong>Time:</strong> {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}</p>

            <div style="background-color: #f8d7da; border: 1px solid #f5c6cb; padding: 15px; border-radius: 5px; margin: 15px 0;">
                <h3 style="margin-top: 0; color: #721c24;">What Happened</h3>
                <table border="0" cellpadding="8" cellspacing="0">
                    <tr><td><strong>Position Address</strong></td><td><code>{position_address}</code></td></tr>
                    <tr><td><strong>Reason</strong></td><td style="color: #dc3545; font-weight: bold;">{reason_label}</td></tr>
                </table>
                <p style="margin-top: 10px; font-size: 13px; color: #721c24;">{details}</p>
            </div>

            <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 5px; margin: 15px 0;">
                <h3 style="margin-top: 0; color: #856404;">What This Means</h3>
                <ul style="margin-bottom: 0; font-size: 13px; color: #856404;">
                    <li>The position may or may not exist on-chain - <strong>manual verification required</strong></li>
                    <li>Recovery has been triggered and the bot will attempt to open a new position</li>
                    <li>If the old position still exists, it will need to be <strong>manually closed</strong></li>
                    <li>Funds may be stuck in the old position until manually recovered</li>
                </ul>
            </div>

            <div style="background-color: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 5px; margin: 15px 0;">
                <h3 style="margin-top: 0; color: #155724;">Recommended Actions</h3>
                <ol style="margin-bottom: 0; font-size: 13px; color: #155724;">
                    <li>Check if position exists on Orca.so: <a href="https://www.orca.so/liquidity">Orca Liquidity</a></li>
                    <li>Search for position address on Solscan: <a href="https://solscan.io/account/{position_address}">View on Solscan</a></li>
                    <li>If position exists, manually close it via Orca UI</li>
                    <li>Check bot logs for more details: <code>flyctl logs -a lp-strategy-v2-instance2</code></li>
                </ol>
            </div>

            {f'<h3>Market Context</h3><p>Price at time of issue: {self._format_price(price)}</p>' if price > 0 else ''}

            {self._build_session_info_html(session_state)}

            <hr>
            <p style="color: #666; font-size: 12px;">LP Strategy v2 - Critical Position Lost notification</p>
        </body>
        </html>
        """

        text_body = f"""
CRITICAL: Position Lost

Time: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}

Position Address: {position_address}
Reason: {reason_label}

Details:
{details}

What This Means:
- The position may or may not exist on-chain - manual verification required
- Recovery has been triggered and the bot will attempt to open a new position
- If the old position still exists, it will need to be manually closed
- Funds may be stuck in the old position until manually recovered

Recommended Actions:
1. Check if position exists on Orca.so: https://www.orca.so/liquidity
2. Search for position on Solscan: https://solscan.io/account/{position_address}
3. If position exists, manually close it via Orca UI
4. Check bot logs: flyctl logs -a lp-strategy-v2-instance2

{f'Price at time of issue: {self._format_price(price)}' if price > 0 else ''}
"""

        return self._send_email(subject, html_body, text_body, attach_csvs=True)


# Module-level instance
_notifier: Optional[EmailNotifier] = None


def get_email_notifier(data_dir: Optional[str] = None) -> EmailNotifier:
    """Get or create global email notifier instance."""
    global _notifier
    if _notifier is None:
        _notifier = EmailNotifier(data_dir=data_dir)
    return _notifier
