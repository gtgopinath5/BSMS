from sqlalchemy.orm import Mapped, mapped_column
from ..database import Base


class Branch(Base):
    __tablename__ = "branches"

    id: Mapped[str] = mapped_column(primary_key=True)          # e.g. LOC_CHN_01
    name: Mapped[str] = mapped_column()
    location: Mapped[str] = mapped_column(default="")
    status: Mapped[str] = mapped_column(default="operational")
