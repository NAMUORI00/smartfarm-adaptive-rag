"""Optional local neural embedding backend for isolated research collections."""
import os


class ResearchTextEmbedding:
    preprocessing_revision = "token-window-mean-v1"
    def __init__(self, model_name: str):
        from sentence_transformers import SentenceTransformer
        self.model = SentenceTransformer(model_name, device=os.getenv("RAG_RESEARCH_EMBEDDING_DEVICE", "cpu"), local_files_only=True)
        self.batch_size = max(1, int(os.getenv("RAG_RESEARCH_EMBEDDING_BATCH_SIZE", "8")))
        self.embedding_size = int(self.model.get_sentence_embedding_dimension())
        if self.embedding_size <= 0:
            raise ValueError("Invalid research embedding dimensions")
        self.query_prefix = os.getenv("RAG_RESEARCH_QUERY_PREFIX", "")

    def passage_embed(self, texts):
        import numpy as np
        tokenizer = self.model.tokenizer
        limit = max(8, int(self.model.max_seq_length) - tokenizer.num_special_tokens_to_add())
        stride = max(1, limit - min(24, limit // 4))
        windows, groups = [], []
        for text in texts:
            tokens = tokenizer.encode(text, add_special_tokens=False, truncation=False)
            start = len(windows)
            for offset in range(0, max(1, len(tokens)), stride):
                windows.append(tokenizer.decode(tokens[offset:offset + limit], skip_special_tokens=True))
                if offset + limit >= len(tokens):
                    break
            groups.append((start, len(windows)))
        encoded = self.model.encode(windows, batch_size=getattr(self, "batch_size", 8), normalize_embeddings=True, show_progress_bar=False)
        pooled = np.stack([encoded[start:end].mean(axis=0) for start, end in groups])
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        return pooled / np.maximum(norms, 1e-12)

    def query_embed(self, texts):
        return self.model.encode([self.query_prefix + text for text in texts],
                                 normalize_embeddings=True, show_progress_bar=False)
